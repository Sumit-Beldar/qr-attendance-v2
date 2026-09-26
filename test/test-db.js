'use strict';

const assert = require('assert');
const {
  runMigrations,
  query,
  queryOne,
  execute,
  batch,
  getPresentCount,
  invalidatePresentCount,
  isUniqueConstraintError,
} = require('../src/db');

async function runDbTests() {
  console.log('Running test-db suite for @libsql/client...');

  // 1. Run migrations
  await runMigrations();
  await runMigrations(); // Must be safe to run multiple times
  console.log('  ✓ runMigrations() is idempotent and runs without error');

  // 2. Query tables
  const tables = await query("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = tables.map((t) => t.name);
  for (const required of ['teachers', 'batches', 'students', 'sessions', 'attendance', 'flags', 'settings']) {
    assert(tableNames.includes(required), `Table ${required} should exist`);
  }
  console.log('  ✓ All required tables exist');

  // 3. Query indexes
  const indexes = await query("SELECT name FROM sqlite_master WHERE type='index'");
  const indexNames = indexes.map((i) => i.name);
  assert(indexNames.includes('idx_students_batch'), 'idx_students_batch index exists');
  assert(indexNames.includes('idx_sessions_teacher_ended'), 'idx_sessions_teacher_ended index exists');
  assert(indexNames.includes('idx_attendance_session_student'), 'idx_attendance_session_student index exists');
  assert(indexNames.includes('idx_attendance_session'), 'idx_attendance_session index exists');
  console.log('  ✓ All indexes verified');

  // 4. Test queryOne and execute
  const testBatchName = 'TestBatch_DB_' + Date.now();
  const execRes = await execute('INSERT INTO batches (name) VALUES (?)', [testBatchName]);
  assert(execRes.lastInsertRowid > 0, 'lastInsertRowid returned');
  const batchId = execRes.lastInsertRowid;

  const foundBatch = await queryOne('SELECT * FROM batches WHERE id = ?', [batchId]);
  assert.strictEqual(foundBatch.name, testBatchName);
  console.log('  ✓ execute() and queryOne() work');

  // 5. Test UNIQUE constraint catching
  try {
    await execute('INSERT INTO batches (name) VALUES (?)', [testBatchName]);
    assert.fail('Should have thrown UNIQUE constraint error');
  } catch (err) {
    assert(isUniqueConstraintError(err), 'isUniqueConstraintError should be true');
    console.log('  ✓ isUniqueConstraintError() correctly catches duplicate insert');
  }

  // 6. Test batch write
  const stmts = [
    {
      sql: 'INSERT INTO students (student_id, name, batch_id, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [`S1_${Date.now()}`, 'Student One', batchId, 'hash1', Date.now()],
    },
    {
      sql: 'INSERT INTO students (student_id, name, batch_id, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [`S2_${Date.now()}`, 'Student Two', batchId, 'hash2', Date.now()],
    },
  ];
  await batch(stmts);
  const studentsInBatch = await query('SELECT * FROM students WHERE batch_id = ?', [batchId]);
  assert.strictEqual(studentsInBatch.length, 2);
  console.log('  ✓ batch() atomic write works');

  // 7. Test in-memory present count caching & invalidation
  // Create a dummy teacher and session
  const tRes = await execute(
    'INSERT INTO teachers (username, password_hash, name, created_at) VALUES (?, ?, ?, ?)',
    [`teacher_db_${Date.now()}`, 'hash', 'Test Teacher', Date.now()]
  );
  const sRes = await execute(
    'INSERT INTO sessions (teacher_id, batch_id, title, session_secret, started_at) VALUES (?, ?, ?, ?, ?)',
    [tRes.lastInsertRowid, batchId, 'Test Session', 'secret', Date.now()]
  );
  const sessId = sRes.lastInsertRowid;

  const count1 = await getPresentCount(sessId);
  assert.strictEqual(count1, 0, 'Initial count should be 0');

  // Insert attendance
  await execute(
    'INSERT INTO attendance (session_id, student_id, marked_at, method) VALUES (?, ?, ?, ?)',
    [sessId, studentsInBatch[0].id, Date.now(), 'scanner']
  );

  // Cached count before invalidation
  const countCached = await getPresentCount(sessId);
  assert.strictEqual(countCached, 0, 'Should read cached 0 before invalidation');

  // Invalidate cache
  invalidatePresentCount(sessId);
  const countAfterInvalidate = await getPresentCount(sessId);
  assert.strictEqual(countAfterInvalidate, 1, 'Should read refreshed count 1 after invalidation');
  console.log('  ✓ In-memory present count caching and invalidation works');

  console.log('All DB tests passed!\n');
}

if (require.main === module) {
  runDbTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('DB test failure:', err);
      process.exit(1);
    });
}

module.exports = { runDbTests };
