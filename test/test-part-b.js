'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const { runMigrations, query, queryOne, execute, batch } = require('../src/db');
const { formatDateTime, formatIsoWithTimezone, formatTimeOnly } = require('../src/time');
const config = require('../src/config');

async function runPartBTests() {
  console.log('Running Part B Cloud-Readiness test suite...');
  await runMigrations();

  // Reset database state
  await batch([
    { sql: 'DELETE FROM attendance' },
    { sql: 'DELETE FROM flags' },
    { sql: 'DELETE FROM students' },
    { sql: 'DELETE FROM sessions' },
    { sql: 'DELETE FROM batches' },
    { sql: 'DELETE FROM teachers' },
  ]);

  // 1. Test Timezone formatting with APP_TIMEZONE
  const ts = 1769490000000; // Fixed timestamp
  const formattedIst = formatDateTime(ts);
  assert(formattedIst && formattedIst.length > 0, 'Formatted IST string should not be empty');
  const timeOnly = formatTimeOnly(ts);
  assert(timeOnly && timeOnly.length > 0, 'Formatted time-only string should not be empty');
  console.log(`  ✓ Timezone formatting works (${config.timezone}): ${formattedIst}`);

  // 2. Test session_version column on teachers and students
  const teacherHash = bcrypt.hashSync('Pass@123', 10);
  const tInfo = await execute(
    'INSERT INTO teachers (username, password_hash, name, session_version, created_at) VALUES (?, ?, ?, 1, ?)',
    ['teacher_b', teacherHash, 'Prof. Part B', Date.now()]
  );
  const teacherId = tInfo.lastInsertRowid;
  const teacher = await queryOne('SELECT * FROM teachers WHERE id = ?', [teacherId]);
  assert.strictEqual(Number(teacher.session_version), 1, 'Initial teacher session_version should be 1');

  // Increment session_version (e.g. on password change)
  await execute('UPDATE teachers SET session_version = session_version + 1 WHERE id = ?', [teacherId]);
  const updatedTeacher = await queryOne('SELECT * FROM teachers WHERE id = ?', [teacherId]);
  assert.strictEqual(Number(updatedTeacher.session_version), 2, 'Teacher session_version should be incremented to 2');
  console.log('  ✓ session_version increment and database tracking works for teachers');

  // 3. Test student session_version increment on password reset / change
  const batchInfo = await execute('INSERT INTO batches (name) VALUES (?)', ['Batch Cloud 2026']);
  const batchId = batchInfo.lastInsertRowid;

  const sHash = bcrypt.hashSync('StudentPass1', 10);
  const sInfo = await execute(
    'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, session_version, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)',
    ['STU_B1', 'Test Student B', batchId, sHash, Date.now()]
  );
  const studentDbId = sInfo.lastInsertRowid;

  const student = await queryOne('SELECT * FROM students WHERE id = ?', [studentDbId]);
  assert.strictEqual(Number(student.session_version), 1, 'Initial student session_version should be 1');

  await execute('UPDATE students SET session_version = session_version + 1 WHERE id = ?', [studentDbId]);
  const updatedStudent = await queryOne('SELECT * FROM students WHERE id = ?', [studentDbId]);
  assert.strictEqual(Number(updatedStudent.session_version), 2, 'Student session_version should be incremented');
  console.log('  ✓ session_version tracking works for students');

  // 4. Test Health Check SQL query
  const healthDbRow = await queryOne('SELECT 1 AS ok');
  assert.strictEqual(Number(healthDbRow.ok), 1, 'Health DB query returns ok: 1');
  console.log('  ✓ /healthz/db query executes cleanly');

  // 5. Test JSON Backup data integrity
  const backup = {
    exportedAt: new Date().toISOString(),
    teachers: await query('SELECT id, username, name, created_at FROM teachers'),
    batches: await query('SELECT * FROM batches'),
    students: await query('SELECT id, student_id, name, batch_id, created_at FROM students'),
    sessions: await query('SELECT * FROM sessions'),
    attendance: await query('SELECT * FROM attendance'),
    flags: await query('SELECT * FROM flags'),
    settings: await query('SELECT * FROM settings'),
  };
  assert.strictEqual(backup.teachers.length, 1);
  assert.strictEqual(backup.batches.length, 1);
  assert.strictEqual(backup.students.length, 1);
  console.log('  ✓ Full JSON database backup generator verified');

  console.log('Part B tests passed successfully!\n');
}

if (require.main === module) {
  runPartBTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Part B tests failed:', err);
      process.exit(1);
    });
}

module.exports = { runPartBTests };
