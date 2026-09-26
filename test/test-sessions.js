'use strict';

const assert = require('assert');
const { query, queryOne, execute, runMigrations } = require('../src/db');
const { getCurrentSessionCode, isCodeValidForSession } = require('../src/codes');

async function runSessionTests() {
  console.log('Running session & projector test suite...');
  await runMigrations();

  // 1. Setup sample teacher & batch
  let teacher = await queryOne('SELECT id FROM teachers LIMIT 1');
  if (!teacher) {
    const info = await execute(
      'INSERT INTO teachers (username, password_hash, name, created_at) VALUES (?, ?, ?, ?)',
      ['prof_test', 'hash123', 'Prof Test', Date.now()]
    );
    teacher = { id: info.lastInsertRowid };
  }

  let batch = await queryOne('SELECT id FROM batches LIMIT 1');
  if (!batch) {
    const info = await execute('INSERT INTO batches (name) VALUES (?)', ['Test Batch 2026']);
    batch = { id: info.lastInsertRowid };
  }

  // 2. Start a session
  const sessionSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const startedAt = Date.now();
  const sessionInfo = await execute(
    `INSERT INTO sessions (teacher_id, batch_id, title, session_secret, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [teacher.id, batch.id, 'Data Structures Lecture 1', sessionSecret, startedAt]
  );

  const sessionId = sessionInfo.lastInsertRowid;
  assert(sessionId > 0, 'Session must be created');

  // Verify active session query
  const active = await queryOne('SELECT * FROM sessions WHERE teacher_id = ? AND ended_at IS NULL', [teacher.id]);
  assert.strictEqual(active.id, sessionId);
  assert.strictEqual(active.title, 'Data Structures Lecture 1');

  // 3. Verify Code generation at various offsets
  const currentCodeData = getCurrentSessionCode(sessionSecret, startedAt, startedAt + 1000);
  assert.strictEqual(currentCodeData.code.length, 6);
  assert.strictEqual(currentCodeData.slot, 0);
  assert(currentCodeData.msRemaining > 0 && currentCodeData.msRemaining <= 7000);

  // Check code after 8 seconds (Slot 1)
  const slot1CodeData = getCurrentSessionCode(sessionSecret, startedAt, startedAt + 8000);
  assert.strictEqual(slot1CodeData.slot, 1);
  assert.notStrictEqual(slot1CodeData.code, currentCodeData.code);

  // 4. Verify Code validation window
  assert.strictEqual(isCodeValidForSession(currentCodeData.code, sessionSecret, startedAt, startedAt + 1000), true);
  assert.strictEqual(
    isCodeValidForSession(currentCodeData.code, sessionSecret, startedAt, startedAt + 8000),
    true,
    'Grace period slot 0 accepted at slot 1'
  );

  // 5. End the session
  const endedAt = Date.now();
  await execute('UPDATE sessions SET ended_at = ? WHERE id = ?', [endedAt, sessionId]);

  const endedSession = await queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  assert(endedSession.ended_at !== null, 'Session must be ended');

  console.log('Session test suite passed successfully!');
}

runSessionTests().catch((err) => {
  console.error('Session test suite failed:', err);
  process.exit(1);
});
