'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const config = require('../config');
const { query, queryOne, execute, batch, isUniqueConstraintError, asyncHandler } = require('../db');
const { requireTeacher, checkRateLimit, recordFailedAttempt, clearRateLimit } = require('../auth');
const { getLanIpCandidates, getActiveLanIp } = require('../network');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── setup / auth ─────────────────────────────────────────────────────────────

router.get('/setup-status', asyncHandler(async (req, res) => {
  const row = await queryOne('SELECT COUNT(*) AS count FROM teachers');
  const setupRequired = Number(row.count) === 0;

  res.json({
    ok: true,
    setupRequired,
    isProduction: config.isProduction,
    requiresSetupKey: !!config.setupKey,
    loggedIn: !!(req.session && req.session.teacherId),
  });
}));

router.post('/setup', asyncHandler(async (req, res) => {
  const row = await queryOne('SELECT COUNT(*) AS count FROM teachers');
  if (Number(row.count) > 0) {
    return res.status(400).json({ ok: false, error: 'Teacher account already configured' });
  }

  const { username, password, name, setup_key } = req.body;

  // Lock check in production or when SETUP_KEY is configured
  if (config.setupKey) {
    if (!setup_key || setup_key.trim() !== config.setupKey) {
      return res.status(403).json({ ok: false, error: 'Setup is locked. Valid SETUP_KEY is required.' });
    }
  }

  if (!username?.trim() || !password?.trim() || !name?.trim()) {
    return res.status(400).json({ ok: false, error: 'All fields (Name, Username, Password) are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    const info = await execute(
      'INSERT INTO teachers (username, password_hash, name, session_version, created_at) VALUES (?, ?, ?, 1, ?)',
      [username.trim(), passwordHash, name.trim(), Date.now()]
    );
    req.session = {
      teacherId: info.lastInsertRowid,
      teacherVersion: 1,
      role: 'teacher',
      teacherName: name.trim(),
      teacherUsername: username.trim(),
    };
    return res.json({ ok: true, message: 'Teacher account created successfully' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Failed to create teacher: ' + err.message });
  }
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required' });
  }

  const rateLimitKey = 'teacher_login_' + username.trim().toLowerCase();
  const limitCheck = checkRateLimit(rateLimitKey);
  if (!limitCheck.allowed) return res.status(429).json({ ok: false, error: limitCheck.error });

  const teacher = await queryOne('SELECT * FROM teachers WHERE username = ?', [username.trim()]);
  if (!teacher || !bcrypt.compareSync(password, teacher.password_hash)) {
    recordFailedAttempt(rateLimitKey);
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }

  clearRateLimit(rateLimitKey);

  // Set 12-hour session for teachers
  if (req.sessionOptions) {
    req.sessionOptions.maxAge = 12 * 60 * 60 * 1000;
  }

  req.session = {
    teacherId: teacher.id,
    teacherVersion: teacher.session_version || 1,
    role: 'teacher',
    teacherName: teacher.name,
    teacherUsername: teacher.username,
  };

  res.json({ ok: true, teacher: { id: teacher.id, name: teacher.name, username: teacher.username } });
}));

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', requireTeacher, asyncHandler(async (req, res) => {
  const teacher = await queryOne(
    'SELECT id, username, name, created_at FROM teachers WHERE id = ?',
    [req.session.teacherId]
  );
  if (!teacher) return res.status(404).json({ ok: false, error: 'Teacher not found' });
  res.json({ ok: true, teacher });
}));

// ─── teacher accounts management ──────────────────────────────────────────────

router.get('/accounts', requireTeacher, asyncHandler(async (req, res) => {
  const teachers = await query('SELECT id, username, name, created_at FROM teachers ORDER BY id ASC');
  res.json({ ok: true, teachers });
}));

router.post('/accounts', requireTeacher, asyncHandler(async (req, res) => {
  const { username, password, name } = req.body;
  if (!username?.trim() || !password?.trim() || !name?.trim()) {
    return res.status(400).json({ ok: false, error: 'Name, Username, and Password are all required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  const existing = await queryOne('SELECT id FROM teachers WHERE LOWER(username) = LOWER(?)', [username.trim()]);
  if (existing) {
    return res.status(400).json({ ok: false, error: `A teacher with username "${username.trim()}" already exists` });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    const info = await execute(
      'INSERT INTO teachers (username, password_hash, name, session_version, created_at) VALUES (?, ?, ?, 1, ?)',
      [username.trim(), passwordHash, name.trim(), Date.now()]
    );
    res.json({
      ok: true,
      message: `Teacher "${name.trim()}" created successfully`,
      teacher: { id: info.lastInsertRowid, username: username.trim(), name: name.trim() },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(400).json({ ok: false, error: 'Username already in use' });
    }
    return res.status(500).json({ ok: false, error: 'Failed to create teacher: ' + err.message });
  }
}));

router.post('/accounts/:id/reset-password', requireTeacher, asyncHandler(async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
  }

  const teacher = await queryOne('SELECT id, name FROM teachers WHERE id = ?', [targetId]);
  if (!teacher) {
    return res.status(404).json({ ok: false, error: 'Teacher not found' });
  }

  const passwordHash = bcrypt.hashSync(new_password, 10);
  await execute(
    'UPDATE teachers SET password_hash = ?, session_version = session_version + 1 WHERE id = ?',
    [passwordHash, targetId]
  );

  res.json({ ok: true, message: `Password reset successfully for ${teacher.name}` });
}));

router.delete('/accounts/:id', requireTeacher, asyncHandler(async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const currentTeacherId = req.session.teacherId;

  if (targetId === currentTeacherId) {
    return res.status(400).json({ ok: false, error: 'You cannot delete your own account while logged in.' });
  }

  const countRow = await queryOne('SELECT COUNT(*) AS count FROM teachers');
  if (Number(countRow.count) <= 1) {
    return res.status(400).json({ ok: false, error: 'Cannot delete the only teacher account.' });
  }

  const teacher = await queryOne('SELECT id, name FROM teachers WHERE id = ?', [targetId]);
  if (!teacher) {
    return res.status(404).json({ ok: false, error: 'Teacher not found.' });
  }

  await execute('DELETE FROM teachers WHERE id = ?', [targetId]);
  res.json({ ok: true, message: `Teacher "${teacher.name}" deleted successfully.` });
}));

// ─── batches ─────────────────────────────────────────────────────────────────

router.get('/batches', requireTeacher, asyncHandler(async (req, res) => {
  const batches = await query(
    `SELECT b.id, b.name, COUNT(s.id) AS student_count
     FROM batches b
     LEFT JOIN students s ON s.batch_id = b.id
     GROUP BY b.id
     ORDER BY b.name ASC`
  );
  res.json({ ok: true, batches });
}));

router.post('/batches', requireTeacher, asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Batch name is required' });

  try {
    const info = await execute('INSERT INTO batches (name) VALUES (?)', [name.trim()]);
    res.json({ ok: true, batch: { id: info.lastInsertRowid, name: name.trim(), student_count: 0 } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(400).json({ ok: false, error: 'A batch with this name already exists' });
    }
    throw err;
  }
}));

router.put('/batches/:id', requireTeacher, asyncHandler(async (req, res) => {
  const { name } = req.body;
  const batchId = parseInt(req.params.id, 10);
  if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Batch name is required' });

  try {
    const info = await execute('UPDATE batches SET name = ? WHERE id = ?', [name.trim(), batchId]);
    if (info.rowsAffected === 0) return res.status(404).json({ ok: false, error: 'Batch not found' });
    res.json({ ok: true, message: 'Batch renamed' });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(400).json({ ok: false, error: 'A batch with this name already exists' });
    }
    throw err;
  }
}));

router.delete('/batches/:id', requireTeacher, asyncHandler(async (req, res) => {
  const batchId = parseInt(req.params.id, 10);

  const scRow = await queryOne('SELECT COUNT(*) AS count FROM students WHERE batch_id = ?', [batchId]);
  if (Number(scRow.count) > 0) {
    return res.status(400).json({
      ok: false,
      error: `Cannot delete batch: it contains ${scRow.count} student(s). Delete or reassign students first.`,
    });
  }

  const sessRow = await queryOne('SELECT COUNT(*) AS count FROM sessions WHERE batch_id = ?', [batchId]);
  if (Number(sessRow.count) > 0) {
    return res.status(400).json({
      ok: false,
      error: `Cannot delete batch: it is linked to ${sessRow.count} attendance session(s).`,
    });
  }

  const info = await execute('DELETE FROM batches WHERE id = ?', [batchId]);
  if (info.rowsAffected === 0) return res.status(404).json({ ok: false, error: 'Batch not found' });
  res.json({ ok: true, message: 'Batch deleted' });
}));

// ─── students ─────────────────────────────────────────────────────────────────

router.get('/students', requireTeacher, asyncHandler(async (req, res) => {
  const { batch_id, search } = req.query;
  let sql = `
    SELECT s.id, s.student_id, s.name, s.batch_id, b.name AS batch_name, s.must_change_password, s.created_at
    FROM students s
    JOIN batches b ON b.id = s.batch_id
    WHERE 1=1
  `;
  const params = [];

  if (batch_id) {
    sql += ' AND s.batch_id = ?';
    params.push(parseInt(batch_id, 10));
  }
  if (search?.trim()) {
    sql += ' AND (s.student_id LIKE ? OR s.name LIKE ?)';
    const term = `%${search.trim()}%`;
    params.push(term, term);
  }
  sql += ' ORDER BY s.student_id ASC';

  const students = await query(sql, params);
  res.json({ ok: true, students });
}));

router.post('/students', requireTeacher, asyncHandler(async (req, res) => {
  const { student_id, name, batch_id, password } = req.body;
  if (!student_id?.trim() || !name?.trim() || !batch_id || !password) {
    return res.status(400).json({ ok: false, error: 'Student ID, Name, Batch, and Password are all required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Initial password must be at least 6 characters' });
  }

  const batch = await queryOne('SELECT id FROM batches WHERE id = ?', [parseInt(batch_id, 10)]);
  if (!batch) return res.status(400).json({ ok: false, error: 'Selected batch does not exist' });

  const passwordHash = bcrypt.hashSync(password, 10);
  try {
    const info = await execute(
      `INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, session_version, created_at)
       VALUES (?, ?, ?, ?, 1, 1, ?)`,
      [student_id.trim(), name.trim(), batch.id, passwordHash, Date.now()]
    );
    res.json({
      ok: true,
      student: { id: info.lastInsertRowid, student_id: student_id.trim(), name: name.trim(), batch_id: batch.id },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(400).json({ ok: false, error: `Student ID "${student_id.trim()}" already exists` });
    }
    throw err;
  }
}));

router.post('/students/:id/reset-password', requireTeacher, asyncHandler(async (req, res) => {
  const studentDbId = parseInt(req.params.id, 10);
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
  }

  const passwordHash = bcrypt.hashSync(new_password, 10);
  // Increment session_version to invalidate any existing student session cookies
  const info = await execute(
    'UPDATE students SET password_hash = ?, must_change_password = 1, session_version = session_version + 1 WHERE id = ?',
    [passwordHash, studentDbId]
  );
  if (info.rowsAffected === 0) return res.status(404).json({ ok: false, error: 'Student not found' });
  res.json({ ok: true, message: 'Password reset successfully' });
}));

router.delete('/students/:id', requireTeacher, asyncHandler(async (req, res) => {
  const studentDbId = parseInt(req.params.id, 10);
  const student = await queryOne('SELECT id, student_id, name FROM students WHERE id = ?', [studentDbId]);
  if (!student) return res.status(404).json({ ok: false, error: 'Student not found' });

  const attRow = await queryOne('SELECT COUNT(*) AS count FROM attendance WHERE student_id = ?', [studentDbId]);
  const attCount = Number(attRow.count);

  await batch([
    { sql: 'DELETE FROM attendance WHERE student_id = ?', args: [studentDbId] },
    { sql: 'DELETE FROM flags WHERE student_id = ?', args: [studentDbId] },
    { sql: 'DELETE FROM students WHERE id = ?', args: [studentDbId] },
  ]);

  res.json({
    ok: true,
    message: `Student ${student.student_id} (${student.name}) deleted along with ${attCount} attendance records.`,
  });
}));

// ─── sample CSV download ──────────────────────────────────────────────────────

router.get('/students/sample-csv', requireTeacher, (req, res) => {
  const sample = `student_id,name,batch,password\nCS202601,Alex Johnson,SE-A 2026,Pass@123\nCS202602,Samira Khan,SE-A 2026,Pass@123\nCS202603,Liam Chen,SE-B 2026,Pass@123\n`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="students_sample.csv"');
  res.send(sample);
});

// ─── CSV parsing helper ───────────────────────────────────────────────────────

function parseCsvLines(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  const parseRow = (line) => {
    const row = [];
    let inQuotes = false;
    let current = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        row.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    row.push(current.trim());
    return row;
  };

  return lines.map(parseRow);
}

// ─── CSV preview ──────────────────────────────────────────────────────────────

router.post(
  '/students/csv-preview',
  requireTeacher,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    let csvContent = '';
    if (req.file) csvContent = req.file.buffer.toString('utf8');
    else if (req.body.csv_text) csvContent = req.body.csv_text;
    else return res.status(400).json({ ok: false, error: 'No CSV file or text provided' });

    const rows = parseCsvLines(csvContent);
    if (rows.length < 2) {
      return res.status(400).json({ ok: false, error: 'CSV must contain a header row and at least one data row' });
    }

    const headers = rows[0].map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));
    const idIdx = headers.indexOf('studentid');
    const nameIdx = headers.indexOf('name');
    const batchIdx = headers.indexOf('batch');
    const passIdx = headers.indexOf('password');

    if (idIdx === -1 || nameIdx === -1 || batchIdx === -1 || passIdx === -1) {
      return res.status(400).json({ ok: false, error: 'CSV headers must include: student_id, name, batch, password' });
    }

    const existingStudents = new Set((await query('SELECT student_id FROM students')).map((s) => s.student_id.toLowerCase()));

    const seenInCsv = new Set();
    const validRows = [];
    const invalidRows = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;
      const studentId = (row[idIdx] || '').trim();
      const name = (row[nameIdx] || '').trim();
      const batchName = (row[batchIdx] || '').trim();
      const password = (row[passIdx] || '').trim();

      if (!studentId || !name || !batchName || !password) {
        invalidRows.push({ rowNum, error: 'Missing one or more required fields' });
        continue;
      }
      if (password.length < 6) {
        invalidRows.push({ rowNum, studentId, error: 'Password must be at least 6 characters' });
        continue;
      }
      const lowerId = studentId.toLowerCase();
      if (seenInCsv.has(lowerId)) {
        invalidRows.push({ rowNum, studentId, error: 'Duplicate Student ID in CSV file' });
        continue;
      }
      if (existingStudents.has(lowerId)) {
        invalidRows.push({ rowNum, studentId, error: 'Student ID already exists in database' });
        continue;
      }
      seenInCsv.add(lowerId);
      validRows.push({ rowNum, student_id: studentId, name, batch: batchName, password });
    }

    res.json({
      ok: true,
      totalRows: rows.length - 1,
      validCount: validRows.length,
      invalidCount: invalidRows.length,
      validRows,
      invalidRows,
    });
  })
);

// ─── CSV import (all-or-nothing) ──────────────────────────────────────────────

router.post(
  '/students/csv-import',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const { students } = req.body;
    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid student records to import' });
    }

    const now = Date.now();
    const batchMap = new Map();
    const stmts = [];

    for (const item of students) {
      const studentId = (item.student_id || '').trim();
      const name = (item.name || '').trim();
      const batchName = (item.batch || '').trim();
      const password = (item.password || '').trim();
      if (!studentId || !name || !batchName || !password) continue;

      if (!batchMap.has(batchName)) {
        const existing = await queryOne('SELECT id FROM batches WHERE name = ?', [batchName]);
        if (existing) {
          batchMap.set(batchName, existing.id);
        } else {
          const info = await execute('INSERT INTO batches (name) VALUES (?)', [batchName]);
          batchMap.set(batchName, info.lastInsertRowid);
        }
      }
      const batchId = batchMap.get(batchName);
      const hash = bcrypt.hashSync(password, 10);
      stmts.push({
        sql: `INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, session_version, created_at)
            VALUES (?, ?, ?, ?, 1, 1, ?)`,
        args: [studentId, name, batchId, hash, now],
      });
    }

    if (!stmts.length) return res.status(400).json({ ok: false, error: 'No importable rows after validation' });

    await batch(stmts);

    res.json({ ok: true, importedCount: stmts.length, message: `Successfully imported ${stmts.length} student(s)` });
  })
);

// ─── settings ─────────────────────────────────────────────────────────────────

router.get('/settings', requireTeacher, asyncHandler(async (req, res) => {
  const rows = await query('SELECT key, value FROM settings');
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const publicBaseUrl = config.publicBaseUrl;
  const activeIp = publicBaseUrl ? publicBaseUrl : getActiveLanIp();

  res.json({
    ok: true,
    settings,
    activeIp,
    publicBaseUrl,
    candidates: getLanIpCandidates(),
    timezone: config.timezone,
  });
}));

router.post(
  '/settings',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const {
      preferred_ip,
      device_lock,
      grace_window_slots,
      location_mode,
      classroom_lat,
      classroom_lng,
      classroom_radius,
    } = req.body;

    const stmts = [];

    if (preferred_ip !== undefined) {
      stmts.push({
        sql: `INSERT INTO settings (key, value) VALUES ('preferred_ip', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [preferred_ip.trim()],
      });
    }
    if (device_lock !== undefined) {
      stmts.push({
        sql: `INSERT INTO settings (key, value) VALUES ('device_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(device_lock)],
      });
    }
    if (grace_window_slots !== undefined) {
      stmts.push({
        sql: `INSERT INTO settings (key, value) VALUES ('grace_window_slots', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(grace_window_slots)],
      });
    }
    if (location_mode !== undefined) {
      stmts.push({
        sql: `INSERT INTO settings (key, value) VALUES ('location_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(location_mode)],
      });
    }
    if (classroom_lat !== undefined) {
      stmts.push({
        sql: `INSERT INTO settings (key, value) VALUES ('classroom_lat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(classroom_lat).trim()],
      });
    }
    if (classroom_lng !== undefined) {
      stmts.push({
        sql: `INSERT INTO settings (key, value) VALUES ('classroom_lng', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(classroom_lng).trim()],
      });
    }
    if (classroom_radius !== undefined) {
      stmts.push({
        sql: `INSERT INTO settings (key, value) VALUES ('classroom_radius', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(classroom_radius)],
      });
    }

    if (stmts.length) await batch(stmts);
    res.json({ ok: true, message: 'Settings saved successfully' });
  })
);

// ─── full database backup (JSON) ──────────────────────────────────────────────

router.get('/backup', requireTeacher, asyncHandler(async (req, res) => {
  const backup = {
    exportedAt: new Date().toISOString(),
    teachers: await query('SELECT id, username, name, created_at FROM teachers'),
    batches: await query('SELECT * FROM batches'),
    students: await query('SELECT id, student_id, name, batch_id, must_change_password, created_at FROM students'),
    sessions: await query('SELECT * FROM sessions'),
    attendance: await query('SELECT * FROM attendance'),
    flags: await query('SELECT * FROM flags'),
    settings: await query('SELECT * FROM settings'),
  };

  const filename = `attendance_backup_${Date.now()}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(backup, null, 2));
}));

module.exports = router;
