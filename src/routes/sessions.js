'use strict';

const express = require('express');
const router = express.Router();
const config = require('../config');
const { query, queryOne, execute, getPresentCount, asyncHandler } = require('../db');
const { requireTeacher } = require('../auth');
const { generateSessionSecret, getCurrentSessionCode, generateQrSvg } = require('../codes');
const { getActiveLanIp } = require('../network');
const { formatDateTime } = require('../time');

const HTTPS_PORT = 3443;

// Helper to escape CSV field values
function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

// Student link QR code SVG for teacher screen display
router.get(
  '/student-link-qr',
  requireTeacher,
  asyncHandler(async (req, res) => {
    let url;
    if (config.publicBaseUrl) {
      url = config.publicBaseUrl;
    } else {
      const lanIp = getActiveLanIp();
      url = `https://${lanIp}:${HTTPS_PORT}`;
    }

    try {
      const svg = await generateQrSvg(url);
      res.json({ ok: true, url, qrSvg: svg });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to generate QR' });
    }
  })
);

// List all sessions for teacher (History)
router.get(
  '/history',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const teacherId = req.session.teacherId;
    const sessions = await query(
      `SELECT s.id, s.title, s.started_at, s.ended_at, b.name as batch_name,
            (SELECT COUNT(*) FROM students WHERE batch_id = s.batch_id) as total_students,
            (SELECT COUNT(*) FROM attendance WHERE session_id = s.id) as present_count,
            (SELECT COUNT(*) FROM flags WHERE session_id = s.id) as flag_count
     FROM sessions s
     JOIN batches b ON b.id = s.batch_id
     WHERE s.teacher_id = ?
     ORDER BY s.started_at DESC`,
      [teacherId]
    );

    res.json({ ok: true, sessions });
  })
);

// Get Active Session for the current teacher (if any)
router.get(
  '/active',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const teacherId = req.session.teacherId;
    const session = await queryOne(
      `SELECT s.id, s.teacher_id, s.batch_id, s.title, s.started_at, s.ended_at, b.name as batch_name,
            (SELECT COUNT(*) FROM students WHERE batch_id = s.batch_id) as total_students,
            (SELECT COUNT(*) FROM attendance WHERE session_id = s.id) as present_count,
            (SELECT COUNT(*) FROM flags WHERE session_id = s.id) as flag_count
     FROM sessions s
     JOIN batches b ON b.id = s.batch_id
     WHERE s.teacher_id = ? AND s.ended_at IS NULL
     ORDER BY s.started_at DESC LIMIT 1`,
      [teacherId]
    );

    res.json({ ok: true, activeSession: session || null });
  })
);

// Start New Session
router.post(
  '/start',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const teacherId = req.session.teacherId;
    const { batch_id, title } = req.body;

    if (!batch_id || !title || !title.trim()) {
      return res.status(400).json({ ok: false, error: 'Batch and Lecture Title are required' });
    }

    const batch = await queryOne('SELECT id, name FROM batches WHERE id = ?', [parseInt(batch_id, 10)]);
    if (!batch) {
      return res.status(400).json({ ok: false, error: 'Selected batch does not exist' });
    }

    // End any previously active session for this teacher
    await execute('UPDATE sessions SET ended_at = ? WHERE teacher_id = ? AND ended_at IS NULL', [
      Date.now(),
      teacherId,
    ]);

    const sessionSecret = generateSessionSecret();
    const startedAt = Date.now();

    try {
      const info = await execute(
        `INSERT INTO sessions (teacher_id, batch_id, title, session_secret, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
        [teacherId, batch.id, title.trim(), sessionSecret, startedAt]
      );

      const sessionId = info.lastInsertRowid;
      res.json({
        ok: true,
        session: {
          id: sessionId,
          title: title.trim(),
          batch_id: batch.id,
          batch_name: batch.name,
          started_at: startedAt,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to start session: ' + err.message });
    }
  })
);

// End Session
router.post(
  '/:id/end',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const teacherId = req.session.teacherId;

    const session = await queryOne('SELECT * FROM sessions WHERE id = ? AND teacher_id = ?', [sessionId, teacherId]);
    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    if (session.ended_at) {
      return res.json({ ok: true, message: 'Session was already closed', session });
    }

    const endedAt = Date.now();
    await execute('UPDATE sessions SET ended_at = ? WHERE id = ?', [endedAt, sessionId]);

    res.json({ ok: true, message: 'Session ended successfully', ended_at: endedAt });
  })
);

// Live Monitoring Data (polled every 2s by teacher live session tab)
router.get(
  '/:id/live',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const teacherId = req.session.teacherId;

    const session = await queryOne(
      `SELECT s.id, s.title, s.started_at, s.ended_at, s.batch_id, b.name as batch_name
     FROM sessions s
     JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ? AND s.teacher_id = ?`,
      [sessionId, teacherId]
    );

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    // Checked-in students (newest first)
    const present = await query(
      `SELECT a.id, a.marked_at, a.method, a.device_id, s.student_id, s.name
     FROM attendance a
     JOIN students s ON s.id = a.student_id
     WHERE a.session_id = ?
     ORDER BY a.marked_at DESC`,
      [sessionId]
    );

    // Absent students (students in batch who have not checked in)
    const absent = await query(
      `SELECT s.id, s.student_id, s.name
     FROM students s
     WHERE s.batch_id = ? AND s.id NOT IN (
       SELECT student_id FROM attendance WHERE session_id = ?
     )
     ORDER BY s.student_id ASC`,
      [session.batch_id, sessionId]
    );

    // Flags for this session
    const flags = await query(
      `SELECT f.id, f.reason, f.device_id, f.created_at, s.student_id, s.name
     FROM flags f
     JOIN students s ON s.id = f.student_id
     WHERE f.session_id = ?
     ORDER BY f.created_at DESC`,
      [sessionId]
    );

    res.json({
      ok: true,
      session,
      present,
      absent,
      flags,
      totalStudents: present.length + absent.length,
      presentCount: present.length,
    });
  })
);

// Export Session Attendance to CSV (Timezone-aware)
router.get(
  '/:id/export-csv',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const teacherId = req.session.teacherId;

    const session = await queryOne(
      `SELECT s.id, s.title, s.started_at, s.ended_at, s.batch_id, b.name as batch_name
     FROM sessions s
     JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ? AND s.teacher_id = ?`,
      [sessionId, teacherId]
    );

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    const rows = await query(
      `SELECT s.student_id, s.name, b.name as batch_name,
            a.marked_at, a.method
     FROM students s
     JOIN batches b ON b.id = s.batch_id
     LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = ?
     WHERE s.batch_id = ?
     ORDER BY s.student_id ASC`,
      [sessionId, session.batch_id]
    );

    const header = ['student_id', 'name', 'batch', 'status', 'marked_at', 'method'];
    const lines = [header.map(escapeCsv).join(',')];

    for (const r of rows) {
      const isPresent = r.marked_at !== null && r.marked_at !== undefined;
      const status = isPresent ? 'Present' : 'Absent';
      // Format timestamp in application timezone (e.g. Asia/Kolkata)
      const markedAtStr = isPresent ? formatDateTime(r.marked_at) : '';
      const methodStr = isPresent ? r.method || 'scanner' : '';

      const line = [
        escapeCsv(r.student_id),
        escapeCsv(r.name),
        escapeCsv(r.batch_name),
        escapeCsv(status),
        escapeCsv(markedAtStr),
        escapeCsv(methodStr),
      ].join(',');
      lines.push(line);
    }

    const csvData = lines.join('\r\n');
    const safeTitle = session.title.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `attendance_${safeTitle}_${session.id}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);
  })
);

// Projector Live Code Endpoint (Polled every 1s by Projector tab)
router.get(
  '/:id/current',
  asyncHandler(async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const session = await queryOne(
      `SELECT s.id, s.title, s.session_secret, s.started_at, s.ended_at, b.name as batch_name,
            (SELECT COUNT(*) FROM students WHERE batch_id = s.batch_id) as total_students
     FROM sessions s
     JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ?`,
      [sessionId]
    );

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    const presentCount = await getPresentCount(sessionId);

    if (session.ended_at) {
      return res.json({
        ok: true,
        active: false,
        title: session.title,
        batchName: session.batch_name,
        presentCount,
        totalStudents: Number(session.total_students),
        message: 'Attendance for this session is closed',
      });
    }

    const now = Date.now();
    const { code, msRemaining } = getCurrentSessionCode(session.session_secret, Number(session.started_at), now);

    let fullUrl;
    let shortDisplay;

    if (config.publicBaseUrl) {
      fullUrl = `${config.publicBaseUrl}/a/${code}`;
      const domainAndPort = config.publicBaseUrl.replace(/^https?:\/\//, '');
      shortDisplay = `${domainAndPort}/a/${code}`;
    } else {
      const lanIp = getActiveLanIp();
      const shortHost = `${lanIp}:${HTTPS_PORT}`;
      fullUrl = `https://${shortHost}/a/${code}`;
      shortDisplay = `${shortHost}/a/${code}`;
    }

    try {
      const qrSvg = await generateQrSvg(fullUrl);
      res.json({
        ok: true,
        active: true,
        code,
        url: fullUrl,
        shortDisplay,
        qrSvg,
        msRemaining,
        title: session.title,
        batchName: session.batch_name,
        presentCount,
        totalStudents: Number(session.total_students),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Error generating QR code' });
    }
  })
);

module.exports = router;
