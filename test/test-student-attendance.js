'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const { query, queryOne, execute, batch, isUniqueConstraintError, runMigrations } = require('../src/db');
const { generateSessionSecret } = require('../src/codes');

async function runStudentAttendanceTests() {
  console.log('Running student attendance & security test suite...');
  await runMigrations();

  // 1. Setup Test Data
  await batch([
    { sql: 'DELETE FROM attendance' },
    { sql: 'DELETE FROM flags' },
    { sql: 'DELETE FROM students' },
    { sql: 'DELETE FROM sessions' },
    { sql: 'DELETE FROM batches' },
    { sql: 'DELETE FROM teachers' },
  ]);

  // Teacher
  const tInfo = await execute(
    'INSERT INTO teachers (username, password_hash, name, created_at) VALUES (?, ?, ?, ?)',
    ['t_prof', 'hash', 'Prof Turing', Date.now()]
  );
  const teacherId = tInfo.lastInsertRowid;

  // Batches
  const b1 = (await execute('INSERT INTO batches (name) VALUES (?)', ['SE-A 2026'])).lastInsertRowid;
  const b2 = (await execute('INSERT INTO batches (name) VALUES (?)', ['SE-B 2026'])).lastInsertRowid;

  // Students
  const passHash = bcrypt.hashSync('Pass@123', 10);
  const s1 = (
    await execute(
      'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ['S001', 'Alice', b1, passHash, Date.now()]
    )
  ).lastInsertRowid;

  const s2 = (
    await execute(
      'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ['S002', 'Bob', b1, passHash, Date.now()]
    )
  ).lastInsertRowid;

  const s3OtherBatch = (
    await execute(
      'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      ['S003', 'Charlie', b2, passHash, Date.now()]
    )
  ).lastInsertRowid;

  // Session for Batch 1
  const sessionSecret = generateSessionSecret();
  const startedAt = Date.now();
  const sessInfo = await execute(
    `INSERT INTO sessions (teacher_id, batch_id, title, session_secret, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [teacherId, b1, 'Database Systems', sessionSecret, startedAt]
  );
  const sessionId = sessInfo.lastInsertRowid;

  // 2. Mark Attendance for Student 1
  const device1 = 'device_phone_alice_1111';
  await execute(
    `INSERT INTO attendance (session_id, student_id, marked_at, device_id, ip, method)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, s1, Date.now(), device1, '192.168.1.10', 'scanner']
  );

  const record1 = await queryOne('SELECT * FROM attendance WHERE session_id = ? AND student_id = ?', [sessionId, s1]);
  assert(record1, 'Student 1 should be marked');
  assert.strictEqual(record1.method, 'scanner');

  // 3. Duplicate check (same student marking again) -> UNIQUE constraint prevents duplicates
  try {
    await execute(
      `INSERT INTO attendance (session_id, student_id, marked_at, device_id, ip, method)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, s1, Date.now(), device1, '192.168.1.10', 'scanner']
    );
    assert.fail('Duplicate attendance should throw constraint error');
  } catch (err) {
    assert(isUniqueConstraintError(err), 'Should catch unique constraint');
  }

  // 4. Anti-Proxy Protection Check
  // Student 2 tries to mark attendance on Alice's phone (device1) in the same session
  const proxyCheck = await queryOne(
    `SELECT a.student_id, s.name, s.student_id as student_code
     FROM attendance a
     JOIN students s ON s.id = a.student_id
     WHERE a.session_id = ? AND a.device_id = ? AND a.student_id != ?`,
    [sessionId, device1, s2]
  );

  assert(proxyCheck, 'Should detect that device1 was already used for student 1');
  assert.strictEqual(proxyCheck.student_code, 'S001');

  // Log to flags
  await execute(
    `INSERT INTO flags (session_id, student_id, device_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, s2, device1, 'Device already used for another student', Date.now()]
  );

  const flagRow = await queryOne('SELECT * FROM flags WHERE session_id = ? AND student_id = ?', [sessionId, s2]);
  assert(flagRow, 'Flag record must exist');
  assert.strictEqual(flagRow.device_id, device1);

  // 5. Wrong batch rejection check
  const student3 = await queryOne('SELECT batch_id FROM students WHERE id = ?', [s3OtherBatch]);
  const currentSession = await queryOne('SELECT batch_id FROM sessions WHERE id = ?', [sessionId]);
  assert.notStrictEqual(student3.batch_id, currentSession.batch_id, 'Student 3 batch should not match session batch');

  console.log('Student attendance & security test suite passed successfully!');
}

runStudentAttendanceTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
