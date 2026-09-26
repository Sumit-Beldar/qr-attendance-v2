/**
 * db.js — async database layer
 *
 * Local mode:  TURSO_DATABASE_URL not set  →  file:./data/app.db
 * Cloud mode:  TURSO_DATABASE_URL + TURSO_AUTH_TOKEN set  →  Turso libSQL
 *
 * All exported functions are async.
 */

'use strict';

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

// ─── connection ──────────────────────────────────────────────────────────────

let client;

function getClient() {
  if (client) return client;

  if (process.env.TURSO_DATABASE_URL) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  } else {
    // Local file mode – ensure the data directory exists
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    client = createClient({ url: 'file:' + path.join(dataDir, 'app.db') });
  }

  return client;
}

// ─── migrations ──────────────────────────────────────────────────────────────

const MIGRATIONS = [
  // v1 – initial schema
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    session_version INTEGER DEFAULT 1 NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER DEFAULT 1,
    session_version INTEGER DEFAULT 1 NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id),
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    title TEXT NOT NULL,
    session_secret TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NULL
  )`,

  `CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    student_id INTEGER NOT NULL REFERENCES students(id),
    marked_at INTEGER NOT NULL,
    device_id TEXT,
    ip TEXT,
    method TEXT CHECK(method IN ('scanner', 'camera-link', 'manual')),
    UNIQUE(session_id, student_id)
  )`,

  `CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    student_id INTEGER NOT NULL REFERENCES students(id),
    device_id TEXT,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS app_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  )`,

  // Indexes – safe to repeat (IF NOT EXISTS)
  `CREATE INDEX IF NOT EXISTS idx_students_batch ON students(batch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_teacher_ended ON sessions(teacher_id, ended_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_session_student ON attendance(session_id, student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_flags_session ON flags(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_app_sessions_expired ON app_sessions(expired)`,

  // Default settings (IGNORE if already there)
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('device_lock', 'true')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('preferred_ip', '')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('grace_window_slots', '2')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('location_mode', 'flag')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('classroom_lat', '')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('classroom_lng', '')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('classroom_radius', '150')`,
];

async function runMigrations() {
  const db = getClient();

  // Run each statement individually; libSQL doesn't support multi-statement exec
  for (const sql of MIGRATIONS) {
    await db.execute(sql);
  }

  // Safe ALTER TABLE for session_version on pre-existing tables
  try {
    await db.execute('ALTER TABLE teachers ADD COLUMN session_version INTEGER DEFAULT 1 NOT NULL');
  } catch (err) {
    // Column already exists, ignore
  }

  try {
    await db.execute('ALTER TABLE students ADD COLUMN session_version INTEGER DEFAULT 1 NOT NULL');
  } catch (err) {
    // Column already exists, ignore
  }
}

// ─── present-count in-memory cache ───────────────────────────────────────────
// The projector polls /current every 1 s, so we avoid a COUNT(*) on every hit.
// presentCounts  Map<sessionId, { count: number, ts: number }>

const presentCounts = new Map();
const COUNT_TTL_MS = 5000; // refresh from DB at most every 5 s

async function getPresentCount(sessionId) {
  const cached = presentCounts.get(sessionId);
  if (cached && Date.now() - cached.ts < COUNT_TTL_MS) {
    return cached.count;
  }

  const db = getClient();
  const rs = await db.execute({
    sql: 'SELECT COUNT(*) AS cnt FROM attendance WHERE session_id = ?',
    args: [sessionId],
  });
  const count = Number(rs.rows[0].cnt);
  presentCounts.set(sessionId, { count, ts: Date.now() });
  return count;
}

function invalidatePresentCount(sessionId) {
  presentCounts.delete(sessionId);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Detect libSQL UNIQUE constraint errors (works for both local and remote).
 */
function isUniqueConstraintError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  // libSQL / SQLite surface it as "UNIQUE constraint failed"
  return msg.includes('unique constraint failed') || msg.includes('unique_constraint');
}

/**
 * asyncHandler – wraps an async route handler and passes errors to next().
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── high-level query helpers ─────────────────────────────────────────────────
// These mirror the better-sqlite3 API used previously, but async.

/**
 * Run a SELECT and return all rows as plain objects.
 */
async function query(sql, args = []) {
  const rs = await getClient().execute({ sql, args });
  return rs.rows.map(rowToObj);
}

/**
 * Run a SELECT and return only the first row (or null).
 */
async function queryOne(sql, args = []) {
  const rs = await getClient().execute({ sql, args });
  if (!rs.rows.length) return null;
  return rowToObj(rs.rows[0]);
}

/**
 * Run an INSERT / UPDATE / DELETE. Returns { rowsAffected, lastInsertRowid }.
 */
async function execute(sql, args = []) {
  const rs = await getClient().execute({ sql, args });
  return {
    rowsAffected: rs.rowsAffected,
    lastInsertRowid: rs.lastInsertRowid ? Number(rs.lastInsertRowid) : null,
  };
}

/**
 * Run multiple statements as an atomic write batch.
 * stmts is an array of { sql, args } objects.
 */
async function batch(stmts) {
  return getClient().batch(
    stmts.map((s) => ({ sql: s.sql, args: s.args || [] })),
    'write'
  );
}

// libSQL row objects carry column metadata; convert to plain {}
function rowToObj(row) {
  if (!row) return null;
  const obj = {};
  for (const key of Object.keys(row)) {
    const v = row[key];
    // BigInt → Number for compatibility with existing code
    obj[key] = typeof v === 'bigint' ? Number(v) : v;
  }
  return obj;
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

async function closeDb() {
  if (client) {
    await client.close();
    client = null;
  }
}

// ─── exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getClient,
  runMigrations,
  query,
  queryOne,
  execute,
  batch,
  getPresentCount,
  invalidatePresentCount,
  isUniqueConstraintError,
  asyncHandler,
  closeDb,
};
