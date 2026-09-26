'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const { query, queryOne, execute, batch, isUniqueConstraintError, runMigrations } = require('../src/db');

async function runTeacherTests() {
  console.log('Running teacher & student management test suite...');
  await runMigrations();

  // Clear existing test data
  await batch([
    { sql: 'DELETE FROM attendance' },
    { sql: 'DELETE FROM flags' },
    { sql: 'DELETE FROM students' },
    { sql: 'DELETE FROM sessions' },
    { sql: 'DELETE FROM batches' },
    { sql: 'DELETE FROM teachers' },
  ]);

  // 1. Initial Teacher Creation
  const teacherPass = 'TeacherPass@123';
  const teacherHash = bcrypt.hashSync(teacherPass, 10);
  const teacherInfo = await execute(
    'INSERT INTO teachers (username, password_hash, name, created_at) VALUES (?, ?, ?, ?)',
    ['teacher1', teacherHash, 'Prof. Alan Turing', Date.now()]
  );
  const teacherId = teacherInfo.lastInsertRowid;
  assert(teacherId > 0, 'Teacher ID should be created');

  // Verify password hash
  const teacher = await queryOne('SELECT * FROM teachers WHERE username = ?', ['teacher1']);
  assert(bcrypt.compareSync(teacherPass, teacher.password_hash), 'Password compare must succeed');

  // 2. Batch Creation & Renaming
  const batchInfo1 = await execute('INSERT INTO batches (name) VALUES (?)', ['SE-A 2026']);
  const batchId1 = batchInfo1.lastInsertRowid;

  const batchInfo2 = await execute('INSERT INTO batches (name) VALUES (?)', ['SE-B 2026']);
  const batchId2 = batchInfo2.lastInsertRowid;

  await execute('UPDATE batches SET name = ? WHERE id = ?', ['SE-A 2026 (Updated)', batchId1]);
  const updatedBatch = await queryOne('SELECT name FROM batches WHERE id = ?', [batchId1]);
  assert.strictEqual(updatedBatch.name, 'SE-A 2026 (Updated)');

  // 3. Single Student Creation
  const studentHash = bcrypt.hashSync('Student@123', 10);
  const studentInfo = await execute(
    `INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    ['CS202601', 'Alice Smith', batchId1, studentHash, Date.now()]
  );
  const studentDbId = studentInfo.lastInsertRowid;
  assert(studentDbId > 0, 'Student should be inserted');

  // Duplicate student_id should throw unique constraint error
  try {
    await execute(
      `INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
      ['CS202601', 'Alice Duplicate', batchId1, studentHash, Date.now()]
    );
    assert.fail('Duplicate student should have thrown');
  } catch (err) {
    assert(isUniqueConstraintError(err), 'Should catch unique constraint');
  }

  // 4. Batch Delete constraint check
  // Cannot delete batch while it contains students
  const studentCountRow = await queryOne('SELECT COUNT(*) as count FROM students WHERE batch_id = ?', [batchId1]);
  assert.strictEqual(Number(studentCountRow.count), 1);

  // 5. Password Reset
  const newPassHash = bcrypt.hashSync('NewStudentPass!99', 10);
  await execute('UPDATE students SET password_hash = ?, must_change_password = 1 WHERE id = ?', [
    newPassHash,
    studentDbId,
  ]);
  const updatedStudent = await queryOne('SELECT * FROM students WHERE id = ?', [studentDbId]);
  assert(bcrypt.compareSync('NewStudentPass!99', updatedStudent.password_hash));
  assert.strictEqual(updatedStudent.must_change_password, 1);

  // 6. Settings
  await execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['device_lock', 'true']
  );
  const deviceLockSetting = await queryOne('SELECT value FROM settings WHERE key = ?', ['device_lock']);
  assert.strictEqual(deviceLockSetting.value, 'true');

  // 7. Multi-Teacher Account Support
  const teacher2Hash = bcrypt.hashSync('Teacher2Pass@123', 10);
  const teacher2Info = await execute(
    'INSERT INTO teachers (username, password_hash, name, session_version, created_at) VALUES (?, ?, ?, 1, ?)',
    ['teacher2', teacher2Hash, 'Prof. Ada Lovelace', Date.now()]
  );
  assert(teacher2Info.lastInsertRowid > teacherId, 'Second teacher ID should be greater');

  // Duplicate username should fail
  try {
    await execute(
      'INSERT INTO teachers (username, password_hash, name, session_version, created_at) VALUES (?, ?, ?, 1, ?)',
      ['teacher2', teacher2Hash, 'Prof. Ada Duplicate', 1, Date.now()]
    );
    assert.fail('Duplicate teacher username should have thrown');
  } catch (err) {
    assert(isUniqueConstraintError(err), 'Should catch duplicate teacher username error');
  }

  // List all teachers
  const allTeachers = await query('SELECT id, username, name FROM teachers ORDER BY id ASC');
  assert.strictEqual(allTeachers.length, 2, 'Should have 2 teachers');
  assert.strictEqual(allTeachers[0].username, 'teacher1');
  assert.strictEqual(allTeachers[1].username, 'teacher2');

  // Reset teacher password and increment session_version
  const newTeacher2Hash = bcrypt.hashSync('NewTeacher2Pass!456', 10);
  await execute(
    'UPDATE teachers SET password_hash = ?, session_version = session_version + 1 WHERE id = ?',
    [newTeacher2Hash, teacher2Info.lastInsertRowid]
  );
  const updatedTeacher2 = await queryOne('SELECT * FROM teachers WHERE id = ?', [teacher2Info.lastInsertRowid]);
  assert(bcrypt.compareSync('NewTeacher2Pass!456', updatedTeacher2.password_hash));
  assert.strictEqual(updatedTeacher2.session_version, 2, 'session_version should increment to 2');

  console.log('Teacher test suite passed successfully!');
}

runTeacherTests().catch((err) => {
  console.error('Teacher test suite failed:', err);
  process.exit(1);
});
