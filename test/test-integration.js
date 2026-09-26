'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const { query, queryOne, execute, batch, runMigrations } = require('../src/db');
const { generateSessionSecret, getCurrentSessionCode, isCodeValidForSession } = require('../src/codes');

async function runIntegrationTest() {
  console.log('Running End-to-End System Integration Test...');
  await runMigrations();

  // Reset database state for testing
  await batch([
    { sql: 'DELETE FROM attendance' },
    { sql: 'DELETE FROM flags' },
    { sql: 'DELETE FROM students' },
    { sql: 'DELETE FROM sessions' },
    { sql: 'DELETE FROM batches' },
    { sql: 'DELETE FROM teachers' },
  ]);

  // 1. Create Teacher
  const teacherHash = bcrypt.hashSync('TeachPass#1', 10);
  const teacher = await execute(
    'INSERT INTO teachers (username, password_hash, name, created_at) VALUES (?, ?, ?, ?)',
    ['prof_knuth', teacherHash, 'Prof. Donald Knuth', Date.now()]
  );
  const teacherId = teacher.lastInsertRowid;

  // 2. Create Batch
  const batchRes = await execute('INSERT INTO batches (name) VALUES (?)', ['Algorithms 2026']);
  const batchId = batchRes.lastInsertRowid;

  // 3. Add Students
  const sHash = bcrypt.hashSync('StudentPass1', 10);
  const s1 = (
    await execute(
      'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ['CS01', 'Grace Hopper', batchId, sHash, Date.now()]
    )
  ).lastInsertRowid;

  const s2 = (
    await execute(
      'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ['CS02', 'Claude Shannon', batchId, sHash, Date.now()]
    )
  ).lastInsertRowid;

  const s3 = (
    await execute(
      'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ['CS03', 'Ada Lovelace', batchId, sHash, Date.now()]
    )
  ).lastInsertRowid;

  // 4. Start Attendance Session
  const sessionSecret = generateSessionSecret();
  const startedAt = Date.now();
  const sessionInfo = await execute(
    'INSERT INTO sessions (teacher_id, batch_id, title, session_secret, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL)',
    [teacherId, batchId, 'Graph Theory Lecture', sessionSecret, startedAt]
  );
  const sessionId = sessionInfo.lastInsertRowid;

  // 5. Code Rotation & Validation
  const codeNow = getCurrentSessionCode(sessionSecret, startedAt, startedAt + 1000);
  assert(isCodeValidForSession(codeNow.code, sessionSecret, startedAt, startedAt + 1000));

  // 6. Grace Hopper checks in on phone 1
  const phone1 = 'device_grace_pixel_7';
  await execute(
    'INSERT INTO attendance (session_id, student_id, marked_at, device_id, ip, method) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, s1, Date.now(), phone1, '192.168.1.101', 'scanner']
  );

  // 7. Proxy Attempt: Claude Shannon tries to use Grace Hopper's phone (phone1)
  const proxyCheck = await queryOne(
    `SELECT a.student_id, s.name, s.student_id as student_code
     FROM attendance a
     JOIN students s ON s.id = a.student_id
     WHERE a.session_id = ? AND a.device_id = ? AND a.student_id != ?`,
    [sessionId, phone1, s2]
  );

  assert(proxyCheck, 'Proxy must be detected');
  assert.strictEqual(proxyCheck.student_code, 'CS01');

  // Insert flag
  await execute(
    'INSERT INTO flags (session_id, student_id, device_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    [sessionId, s2, phone1, 'Device already used for CS01 (Grace Hopper)', Date.now()]
  );

  // Claude Shannon checks in on his own phone (phone2)
  const phone2 = 'device_claude_iphone_14';
  await execute(
    'INSERT INTO attendance (session_id, student_id, marked_at, device_id, ip, method) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, s2, Date.now(), phone2, '192.168.1.102', 'manual']
  );

  // 8. Verify Live Session Data
  const presentStudents = await query(
    `SELECT a.student_id, s.name, a.method FROM attendance a JOIN students s ON s.id = a.student_id WHERE a.session_id = ?`,
    [sessionId]
  );
  assert.strictEqual(presentStudents.length, 2, 'Two students should be marked present');

  const absentStudents = await query(
    `SELECT s.student_id, s.name FROM students s WHERE s.batch_id = ? AND s.id NOT IN (SELECT student_id FROM attendance WHERE session_id = ?)`,
    [batchId, sessionId]
  );
  assert.strictEqual(absentStudents.length, 1, 'One student (Ada) should be absent');
  assert.strictEqual(absentStudents[0].student_id, 'CS03');

  const flags = await query('SELECT * FROM flags WHERE session_id = ?', [sessionId]);
  assert.strictEqual(flags.length, 1, 'One proxy flag should be recorded');

  // 9. Verify CSV Export Data
  const allRows = await query(
    `SELECT s.student_id, s.name, b.name as batch_name, a.marked_at, a.method
     FROM students s
     JOIN batches b ON b.id = s.batch_id
     LEFT JOIN attendance a ON a.student_id = s.id AND a.session_id = ?
     WHERE s.batch_id = ?
     ORDER BY s.student_id ASC`,
    [sessionId, batchId]
  );

  assert.strictEqual(allRows.length, 3);
  assert(allRows[0].marked_at !== null, 'CS01 should have timestamp');
  assert(allRows[1].marked_at !== null, 'CS02 should have timestamp');
  assert.strictEqual(allRows[2].marked_at, null, 'CS03 should be unmarked');

  // 10. End Session
  await execute('UPDATE sessions SET ended_at = ? WHERE id = ?', [Date.now(), sessionId]);
  const endedSession = await queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  assert(endedSession.ended_at !== null, 'Session must be closed');

  console.log('End-to-End System Integration Test passed completely!');
}

runIntegrationTest().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
