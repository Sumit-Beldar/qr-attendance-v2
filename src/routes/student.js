'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query, queryOne, execute, asyncHandler } = require('../db');
const { requireStudent, checkRateLimit, recordFailedAttempt, clearRateLimit } = require('../auth');

// Student Auth Status
router.get('/status', asyncHandler(async (req, res) => {
  if (!req.session || !req.session.studentDbId) {
    return res.json({ ok: true, loggedIn: false });
  }

  const student = await queryOne(
    `SELECT s.id, s.student_id, s.name, s.batch_id, s.must_change_password, s.session_version, b.name as batch_name
     FROM students s
     JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ?`,
    [req.session.studentDbId]
  );

  if (!student || Number(student.session_version) !== Number(req.session.studentVersion || 1)) {
    req.session = null;
    return res.json({ ok: true, loggedIn: false });
  }

  res.json({
    ok: true,
    loggedIn: true,
    student: {
      id: student.id,
      student_id: student.student_id,
      name: student.name,
      batch_id: student.batch_id,
      batch_name: student.batch_name,
      must_change_password: student.must_change_password === 1,
    },
    hasPendingCheckin: !!(req.session.pendingCheckin && Date.now() - req.session.pendingCheckin.scannedAt < 180000),
  });
}));

// Student Login
router.post('/login', asyncHandler(async (req, res) => {
  const { student_id, password } = req.body;
  if (!student_id || !password) {
    return res.status(400).json({ ok: false, error: 'Student ID and password are required' });
  }

  const cleanId = student_id.trim().toUpperCase();
  const rateLimitKey = 'student_login_' + cleanId;
  const limitCheck = checkRateLimit(rateLimitKey);
  if (!limitCheck.allowed) {
    return res.status(429).json({ ok: false, error: limitCheck.error });
  }

  const student = await queryOne(
    `SELECT s.id, s.student_id, s.name, s.batch_id, s.password_hash, s.must_change_password, s.session_version, b.name as batch_name
     FROM students s
     JOIN batches b ON b.id = s.batch_id
     WHERE UPPER(s.student_id) = ?`,
    [cleanId]
  );

  if (!student || !bcrypt.compareSync(password, student.password_hash)) {
    recordFailedAttempt(rateLimitKey);
    return res.status(401).json({ ok: false, error: 'Invalid Student ID or password' });
  }

  clearRateLimit(rateLimitKey);

  // 30-day session for students
  if (req.sessionOptions) {
    req.sessionOptions.maxAge = 30 * 24 * 60 * 60 * 1000;
  }

  const prevPending = req.session ? req.session.pendingCheckin : null;

  req.session = {
    studentDbId: student.id,
    studentVersion: student.session_version || 1,
    role: 'student',
    studentId: student.student_id,
    studentName: student.name,
    batchId: student.batch_id,
    pendingCheckin: prevPending && Date.now() - prevPending.scannedAt < 180000 ? prevPending : null,
  };

  res.json({
    ok: true,
    student: {
      id: student.id,
      student_id: student.student_id,
      name: student.name,
      batch_id: student.batch_id,
      batch_name: student.batch_name,
      must_change_password: student.must_change_password === 1,
    },
    hasPendingCheckin: !!(req.session.pendingCheckin && Date.now() - req.session.pendingCheckin.scannedAt < 180000),
  });
}));

// Student Logout
router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// Change Password (for first-login or account settings)
router.post('/change-password', requireStudent, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  const studentDbId = req.session.studentDbId;

  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
  }

  const student = await queryOne('SELECT * FROM students WHERE id = ?', [studentDbId]);
  if (!student) {
    return res.status(404).json({ ok: false, error: 'Student not found' });
  }

  if (student.must_change_password === 0) {
    if (!current_password || !bcrypt.compareSync(current_password, student.password_hash)) {
      return res.status(400).json({ ok: false, error: 'Current password is incorrect' });
    }
  }

  const newHash = bcrypt.hashSync(new_password, 10);
  const newVersion = (student.session_version || 1) + 1;

  await execute(
    'UPDATE students SET password_hash = ?, must_change_password = 0, session_version = ? WHERE id = ?',
    [newHash, newVersion, studentDbId]
  );

  // Update current session version so current user stays logged in
  if (req.session) {
    req.session.studentVersion = newVersion;
  }

  res.json({ ok: true, message: 'Password updated successfully' });
}));

// Recent Attendance History (last 5 sessions)
router.get('/recent', requireStudent, asyncHandler(async (req, res) => {
  const studentDbId = req.session.studentDbId;
  const recent = await query(
    `SELECT a.id, a.marked_at, a.method, s.title, b.name as batch_name
     FROM attendance a
     JOIN sessions s ON s.id = a.session_id
     JOIN batches b ON b.id = s.batch_id
     WHERE a.student_id = ?
     ORDER BY a.marked_at DESC LIMIT 5`,
    [studentDbId]
  );

  res.json({ ok: true, recent });
}));

module.exports = router;
