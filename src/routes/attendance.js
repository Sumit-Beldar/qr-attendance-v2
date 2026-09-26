'use strict';

const express = require('express');
const router = express.Router();
const { query, queryOne, execute, invalidatePresentCount, isUniqueConstraintError, asyncHandler } = require('../db');
const { requireStudent, requireTeacher, checkAttendanceRateLimit, getOrCreateSecret } = require('../auth');
const { isCodeValidForSession, generateCheckinTicket, verifyCheckinTicket } = require('../codes');
const { validateLocation } = require('../geo');
const { formatDateTime } = require('../time');

/**
 * Helper to process attendance marking for a student in a session (Async)
 */
async function processAttendance({ sessionId, studentDbId, deviceId, clientIp, method, location = {} }) {
  const session = await queryOne(
    `SELECT s.id, s.batch_id, s.title, s.ended_at, b.name as batch_name
     FROM sessions s
     JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ?`,
    [sessionId]
  );

  if (!session) {
    return { status: 404, payload: { ok: false, error: 'Session not found' } };
  }

  if (session.ended_at) {
    return { status: 400, payload: { ok: false, error: 'Attendance for this lecture is closed.' } };
  }

  const student = await queryOne('SELECT id, student_id, name, batch_id FROM students WHERE id = ?', [studentDbId]);
  if (!student) {
    return { status: 404, payload: { ok: false, error: 'Student not found' } };
  }

  // Batch check
  if (student.batch_id !== session.batch_id) {
    return {
      status: 403,
      payload: {
        ok: false,
        error: `You're not in this class (${session.title} – ${session.batch_name})`,
      },
    };
  }

  // Already marked check (Friendly neutral response)
  const existing = await queryOne('SELECT marked_at FROM attendance WHERE session_id = ? AND student_id = ?', [
    session.id,
    student.id,
  ]);

  if (existing) {
    return {
      status: 200,
      payload: {
        ok: true,
        alreadyMarked: true,
        markedAt: Number(existing.marked_at),
        markedAtFormatted: formatDateTime(existing.marked_at),
        session: { id: session.id, title: session.title, batchName: session.batch_name },
        student: { name: student.name, studentId: student.student_id },
      },
    };
  }

  // Load all settings
  const settingsRows = await query('SELECT key, value FROM settings');
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

  // Location validation (Haversine distance check)
  const locationConfig = {
    mode: settings.location_mode || 'flag',
    lat: settings.classroom_lat,
    lng: settings.classroom_lng,
    radius: parseInt(settings.classroom_radius, 10) || 150,
  };

  const locCheck = validateLocation(location, locationConfig);
  if (!locCheck.allowed) {
    return {
      status: 403,
      payload: {
        ok: false,
        error: locCheck.error || 'Location check failed.',
      },
    };
  }

  // Device Lock / Anti-Proxy check
  const isDeviceLockEnabled = settings.device_lock !== 'false';

  if (isDeviceLockEnabled && deviceId) {
    const proxyRecord = await queryOne(
      `SELECT a.student_id, s.name, s.student_id as student_code
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.session_id = ? AND a.device_id = ? AND a.student_id != ?`,
      [session.id, deviceId, student.id]
    );

    if (proxyRecord) {
      // Flag proxy attempt
      await execute(
        `INSERT INTO flags (session_id, student_id, device_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          session.id,
          student.id,
          deviceId,
          `Device already used for ${proxyRecord.student_code} (${proxyRecord.name})`,
          Date.now(),
        ]
      );

      return {
        status: 403,
        payload: {
          ok: false,
          error: 'This phone was already used to mark attendance for another student.',
        },
      };
    }
  }

  // Insert Attendance
  const markedAt = Date.now();
  try {
    await execute(
      `INSERT INTO attendance (session_id, student_id, marked_at, device_id, ip, method)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [session.id, student.id, markedAt, deviceId || null, clientIp || null, method || 'scanner']
    );

    // If location check flagged (e.g. outside classroom in flag-only mode or location denied)
    if (locCheck.flagged) {
      await execute(
        `INSERT INTO flags (session_id, student_id, device_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [session.id, student.id, deviceId || null, locCheck.reason, markedAt]
      );
    }

    invalidatePresentCount(session.id);

    return {
      status: 200,
      payload: {
        ok: true,
        newlyMarked: true,
        markedAt,
        markedAtFormatted: formatDateTime(markedAt),
        session: { id: session.id, title: session.title, batchName: session.batch_name },
        student: { name: student.name, studentId: student.student_id },
        flagged: locCheck.flagged,
        flagReason: locCheck.reason || null,
      },
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const rec = await queryOne('SELECT marked_at FROM attendance WHERE session_id = ? AND student_id = ?', [
        session.id,
        student.id,
      ]);
      return {
        status: 200,
        payload: {
          ok: true,
          alreadyMarked: true,
          markedAt: rec ? Number(rec.marked_at) : markedAt,
          markedAtFormatted: formatDateTime(rec ? rec.marked_at : markedAt),
          session: { id: session.id, title: session.title, batchName: session.batch_name },
          student: { name: student.name, studentId: student.student_id },
        },
      };
    }
    return { status: 500, payload: { ok: false, error: 'Database error recording attendance: ' + err.message } };
  }
}

// ─── Check-in Ticket Flow (separates 7s code expiry from GPS latency) ──────────

// Step 1: Claim Check-in Ticket (validates 7s code immediately)
router.post(
  '/claim-ticket',
  requireStudent,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    const studentDbId = req.session.studentDbId;
    const clientIp = req.ip || req.connection.remoteAddress;

    // Rate limiter check
    const rateCheck = checkAttendanceRateLimit(studentDbId, clientIp);
    if (!rateCheck.allowed) {
      return res.status(429).json({ ok: false, error: rateCheck.error });
    }

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ ok: false, error: 'Attendance code is required' });
    }

    const cleanCode = code.trim().toUpperCase();
    const now = Date.now();

    // Read grace window setting
    const graceSetting = await queryOne("SELECT value FROM settings WHERE key = 'grace_window_slots'");
    const graceSlots = graceSetting ? parseInt(graceSetting.value, 10) || 2 : 2;

    const activeSessions = await query(
      'SELECT id, session_secret, started_at, batch_id, title FROM sessions WHERE ended_at IS NULL'
    );

    if (activeSessions.length === 0) {
      return res.status(400).json({ ok: false, error: 'Attendance for this lecture is closed.' });
    }

    let matchedSession = null;
    for (const sess of activeSessions) {
      if (isCodeValidForSession(cleanCode, sess.session_secret, Number(sess.started_at), now, graceSlots)) {
        matchedSession = sess;
        break;
      }
    }

    if (!matchedSession) {
      return res.status(400).json({
        ok: false,
        error: 'This code has expired. Scan the current code on the screen.',
      });
    }

    // Read location settings
    const locModeSetting = await queryOne("SELECT value FROM settings WHERE key = 'location_mode'");
    const classLatSetting = await queryOne("SELECT value FROM settings WHERE key = 'classroom_lat'");
    const classLngSetting = await queryOne("SELECT value FROM settings WHERE key = 'classroom_lng'");

    const locationMode = locModeSetting ? locModeSetting.value : 'flag';
    const hasClassroomCoords = !!(classLatSetting?.value && classLngSetting?.value);

    // Generate signed 60-second check-in ticket
    const ticket = generateCheckinTicket(matchedSession.id, studentDbId, getOrCreateSecret(), 60000);

    return res.json({
      ok: true,
      ticket,
      sessionId: matchedSession.id,
      sessionTitle: matchedSession.title,
      locationRequired: locationMode !== 'off' && hasClassroomCoords,
      locationMode,
    });
  })
);

// Step 2: Complete Attendance with Ticket and optional Geolocation
router.post(
  '/mark-with-ticket',
  requireStudent,
  asyncHandler(async (req, res) => {
    const { ticket, method, lat, lng, accuracy, locationError } = req.body;
    const studentDbId = req.session.studentDbId;
    const deviceId = req.deviceId || req.cookies.device_id;
    const clientIp = req.ip || req.connection.remoteAddress;

    // Verify Ticket
    const ticketPayload = verifyCheckinTicket(ticket, getOrCreateSecret());
    if (!ticketPayload || ticketPayload.uid !== studentDbId) {
      return res.status(400).json({
        ok: false,
        error: 'Check-in ticket expired or invalid. Please scan the current code on the screen again.',
      });
    }

    const result = await processAttendance({
      sessionId: ticketPayload.sid,
      studentDbId,
      deviceId,
      clientIp,
      method: method || 'scanner',
      location: { lat, lng, accuracy, locationError },
    });

    return res.status(result.status).json(result.payload);
  })
);

// Legacy / Direct mark route with rate limiting
router.post(
  '/mark',
  requireStudent,
  asyncHandler(async (req, res) => {
    const { code, method, lat, lng, accuracy, locationError } = req.body;
    const studentDbId = req.session.studentDbId;
    const deviceId = req.deviceId || req.cookies.device_id;
    const clientIp = req.ip || req.connection.remoteAddress;

    const rateCheck = checkAttendanceRateLimit(studentDbId, clientIp);
    if (!rateCheck.allowed) {
      return res.status(429).json({ ok: false, error: rateCheck.error });
    }

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ ok: false, error: 'Attendance code is required' });
    }

    const cleanCode = code.trim().toUpperCase();
    const now = Date.now();

    const graceSetting = await queryOne("SELECT value FROM settings WHERE key = 'grace_window_slots'");
    const graceSlots = graceSetting ? parseInt(graceSetting.value, 10) || 2 : 2;

    const activeSessions = await query(
      'SELECT id, session_secret, started_at, batch_id, title FROM sessions WHERE ended_at IS NULL'
    );

    if (activeSessions.length === 0) {
      return res.status(400).json({ ok: false, error: 'Attendance for this lecture is closed.' });
    }

    let matchedSession = null;
    for (const sess of activeSessions) {
      if (isCodeValidForSession(cleanCode, sess.session_secret, Number(sess.started_at), now, graceSlots)) {
        matchedSession = sess;
        break;
      }
    }

    if (!matchedSession) {
      return res.status(400).json({
        ok: false,
        error: 'This code has expired. Scan the current code on the screen.',
      });
    }

    const result = await processAttendance({
      sessionId: matchedSession.id,
      studentDbId,
      deviceId,
      clientIp,
      method: method || 'scanner',
      location: { lat, lng, accuracy, locationError },
    });

    return res.status(result.status).json(result.payload);
  })
);

// Complete Pending Check-in (after login)
router.post(
  '/complete-pending',
  requireStudent,
  asyncHandler(async (req, res) => {
    const studentDbId = req.session.studentDbId;
    const deviceId = req.deviceId || req.cookies.device_id;
    const clientIp = req.ip || req.connection.remoteAddress;
    const { lat, lng, accuracy, locationError } = req.body || {};

    const pending = req.session.pendingCheckin;
    if (!pending || !pending.sessionId || Date.now() - pending.scannedAt > 180000) {
      req.session.pendingCheckin = null;
      return res.status(400).json({ ok: false, error: 'No active pending check-in found or check-in expired' });
    }

    req.session.pendingCheckin = null;

    const result = await processAttendance({
      sessionId: pending.sessionId,
      studentDbId,
      deviceId,
      clientIp,
      method: 'camera-link',
      location: { lat, lng, accuracy, locationError },
    });

    return res.status(result.status).json(result.payload);
  })
);

// Direct Scan Route (/a/:code)
router.get(
  '/a/:code',
  asyncHandler(async (req, res) => {
    const rawCode = req.params.code;
    if (!rawCode) {
      return res.redirect('/student');
    }

    const cleanCode = rawCode.trim().toUpperCase();
    const now = Date.now();

    const graceSetting = await queryOne("SELECT value FROM settings WHERE key = 'grace_window_slots'");
    const graceSlots = graceSetting ? parseInt(graceSetting.value, 10) || 2 : 2;

    const activeSessions = await query(
      'SELECT id, session_secret, started_at, batch_id, title FROM sessions WHERE ended_at IS NULL'
    );

    let matchedSession = null;
    for (const sess of activeSessions) {
      if (isCodeValidForSession(cleanCode, sess.session_secret, Number(sess.started_at), now, graceSlots)) {
        matchedSession = sess;
        break;
      }
    }

    if (!matchedSession) {
      return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code Expired</title>
        <link rel="stylesheet" href="/css/style.css">
      </head>
      <body>
        <div class="container-narrow" style="margin-top: 40px; text-align: center;">
          <div class="card">
            <h1 style="color: var(--error);">Code Expired</h1>
            <p style="margin: 16px 0;">This attendance code has expired or the session is closed. Please scan the current code displayed on the screen.</p>
            <a href="/student" class="btn btn-primary btn-block btn-lg">Open Attendance App</a>
          </div>
        </div>
      </body>
      </html>
    `);
    }

    // If student is already logged in, mark directly
    if (req.session && req.session.studentDbId) {
      const deviceId = req.deviceId || req.cookies.device_id;
      const clientIp = req.ip || req.connection.remoteAddress;

      const result = await processAttendance({
        sessionId: matchedSession.id,
        studentDbId: req.session.studentDbId,
        deviceId,
        clientIp,
        method: 'camera-link',
      });

      if (result.payload.ok) {
        return res.redirect('/student?direct_success=1');
      } else {
        return res.status(result.status).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Attendance Error</title>
          <link rel="stylesheet" href="/css/style.css">
        </head>
        <body>
          <div class="container-narrow" style="margin-top: 40px;">
            <div class="card">
              <h1 style="color: var(--error);">Notice</h1>
              <p style="margin: 16px 0;">${result.payload.error}</p>
              <a href="/student" class="btn btn-primary btn-block btn-lg">Back to Home</a>
            </div>
          </div>
        </body>
        </html>
      `);
      }
    }

    // If not logged in, save pending check-in and redirect to login
    req.session.pendingCheckin = {
      sessionId: matchedSession.id,
      scannedAt: Date.now(),
    };

    return res.redirect('/student/login?pending=1');
  })
);

// ─── Teacher Removal of Check-in ──────────────────────────────────────────────

router.delete(
  '/:id',
  requireTeacher,
  asyncHandler(async (req, res) => {
    const attendanceId = parseInt(req.params.id, 10);
    const attendance = await queryOne(
      `SELECT a.id, a.session_id, a.student_id, s.name, s.student_id as student_code
       FROM attendance a
       JOIN students s ON s.id = a.student_id
       WHERE a.id = ?`,
      [attendanceId]
    );

    if (!attendance) {
      return res.status(404).json({ ok: false, error: 'Attendance record not found' });
    }

    // Delete attendance record
    await execute('DELETE FROM attendance WHERE id = ?', [attendanceId]);

    // Log teacher removal flag
    await execute(
      `INSERT INTO flags (session_id, student_id, device_id, reason, created_at)
       VALUES (?, ?, NULL, ?, ?)`,
      [
        attendance.session_id,
        attendance.student_id,
        `Check-in removed by teacher for ${attendance.student_code} (${attendance.name})`,
        Date.now(),
      ]
    );

    invalidatePresentCount(attendance.session_id);

    res.json({
      ok: true,
      message: `Attendance removed for ${attendance.student_code} (${attendance.name})`,
    });
  })
);

module.exports = router;
