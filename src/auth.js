/**
 * auth.js
 * Cookie-session configuration, rate limiting, and auth middleware with session_version check.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { queryOne, asyncHandler } = require('./db');

// ─── session secret ───────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

function getOrCreateSecret() {
  if (config.sessionSecret) return config.sessionSecret;

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (saved.sessionSecret) return saved.sessionSecret;
    } catch (e) {
      /* ignore */
    }
  }

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ sessionSecret: secret }, null, 2), 'utf8');
  return secret;
}

// ─── in-memory rate limiter ───────────────────────────────────────────────────

const loginAttempts = new Map();

function checkRateLimit(key) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxAttempts = 5;

  const record = (loginAttempts.get(key) || []).filter((ts) => now - ts < windowMs);
  loginAttempts.set(key, record);

  if (record.length >= maxAttempts) {
    const waitMs = windowMs - (now - record[0]);
    const waitMins = Math.ceil(waitMs / 60000);
    return {
      allowed: false,
      error: `Too many attempts, try again in ${waitMins} minute${waitMins > 1 ? 's' : ''}`,
    };
  }
  return { allowed: true };
}

function recordFailedAttempt(key) {
  const record = loginAttempts.get(key) || [];
  record.push(Date.now());
  loginAttempts.set(key, record);
}

function clearRateLimit(key) {
  loginAttempts.delete(key);
}

// In-memory check-in rate limiter: 20 requests per minute per student and per IP
const checkinAttempts = new Map();

function checkAttendanceRateLimit(studentDbId, clientIp) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 20;

  const keys = [];
  if (studentDbId) keys.push(`att_student_${studentDbId}`);
  if (clientIp) keys.push(`att_ip_${clientIp}`);

  for (const key of keys) {
    const record = (checkinAttempts.get(key) || []).filter((ts) => now - ts < windowMs);
    if (record.length >= maxRequests) {
      return {
        allowed: false,
        error: 'Too many check-in requests. Please wait a minute before trying again.',
      };
    }
    record.push(now);
    checkinAttempts.set(key, record);
  }

  return { allowed: true };
}

// ─── auth middleware with session_version invalidation ────────────────────────

async function requireTeacher(req, res, next) {
  if (req.session && req.session.teacherId) {
    // Validate session_version against database
    try {
      const teacher = await queryOne('SELECT id, session_version FROM teachers WHERE id = ?', [req.session.teacherId]);
      if (teacher && Number(teacher.session_version) === Number(req.session.teacherVersion || 1)) {
        return next();
      }
    } catch (err) {
      console.error('Teacher auth check error:', err);
    }
    // Invalidate session on mismatch
    req.session = null;
  }

  if (req.originalUrl?.startsWith('/api/') || req.path.startsWith('/api/')) {
    return res.status(403).json({ ok: false, error: 'Teacher authentication required' });
  }
  return res.redirect('/teacher/login');
}

async function requireStudent(req, res, next) {
  if (req.session && req.session.studentDbId) {
    // Validate session_version against database
    try {
      const student = await queryOne('SELECT id, session_version FROM students WHERE id = ?', [req.session.studentDbId]);
      if (student && Number(student.session_version) === Number(req.session.studentVersion || 1)) {
        return next();
      }
    } catch (err) {
      console.error('Student auth check error:', err);
    }
    // Invalidate session on mismatch
    req.session = null;
  }

  if (req.originalUrl?.startsWith('/api/') || req.path.startsWith('/api/')) {
    return res.status(403).json({ ok: false, error: 'Student authentication required' });
  }
  return res.redirect('/student/login');
}

module.exports = {
  getOrCreateSecret,
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
  checkAttendanceRateLimit,
  requireTeacher: asyncHandler(requireTeacher),
  requireStudent: asyncHandler(requireStudent),
};
