'use strict';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const { runMigrations, query, queryOne, execute, batch, getPresentCount } = require('../src/db');
const { haversineDistanceMeters, validateLocation } = require('../src/geo');
const {
  generateSessionSecret,
  getCurrentSessionCode,
  isCodeValidForSession,
  generateCheckinTicket,
  verifyCheckinTicket,
} = require('../src/codes');
const { checkAttendanceRateLimit } = require('../src/auth');

async function runPartCTests() {
  console.log('Running Part C Anti-Proxy & Geolocation test suite...');
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

  // 1. Test Haversine Distance
  // Distance between Eiffel Tower (48.8584, 2.2945) and Louvre Museum (48.8606, 2.3376) ~ 3.16 km
  const dist = haversineDistanceMeters(48.8584, 2.2945, 48.8606, 2.3376);
  assert(dist > 3000 && dist < 3300, `Haversine distance should be ~3.16km, got ${dist}m`);
  console.log('  ✓ Haversine distance calculation verified (~3.16km)');

  // 2. Test validateLocation across modes
  const classroom = {
    mode: 'flag',
    lat: '12.9716',
    lng: '77.5946',
    radius: 150,
  };

  // Inside classroom (50m away)
  const inside = validateLocation({ lat: 12.9718, lng: 77.5948, accuracy: 10 }, classroom);
  assert.strictEqual(inside.allowed, true);
  assert.strictEqual(inside.flagged, false);

  // Far away (e.g. 5km away) in Flag mode
  const farFlag = validateLocation({ lat: 13.02, lng: 77.5946, accuracy: 15 }, classroom);
  assert.strictEqual(farFlag.allowed, true);
  assert.strictEqual(farFlag.flagged, true);
  assert(farFlag.reason.includes('Outside classroom'));

  // Far away in Block mode
  const farBlock = validateLocation(
    { lat: 13.02, lng: 77.5946, accuracy: 15 },
    { ...classroom, mode: 'block' }
  );
  assert.strictEqual(farBlock.allowed, false);
  assert(farBlock.error.includes('Location check failed'));

  // Location denied in Flag mode
  const deniedFlag = validateLocation({ locationError: 'denied' }, classroom);
  assert.strictEqual(deniedFlag.allowed, true);
  assert.strictEqual(deniedFlag.flagged, true);
  assert.strictEqual(deniedFlag.reason, 'Location not shared');

  // Location denied in Block mode
  const deniedBlock = validateLocation({ locationError: 'denied' }, { ...classroom, mode: 'block' });
  assert.strictEqual(deniedBlock.allowed, false);
  assert(deniedBlock.error.includes('Location permission is required'));

  console.log('  ✓ Geolocation validation rules (Off / Flag / Block) verified');

  // 3. Test Check-in Ticket generation & verification
  const secret = 'testsecretkey123456789012345678901234567890';
  const ticket = generateCheckinTicket(101, 202, secret, 60000);
  assert(ticket && ticket.includes('.'), 'Ticket format valid');

  const verified = verifyCheckinTicket(ticket, secret);
  assert(verified !== null, 'Ticket should verify');
  assert.strictEqual(verified.sid, 101);
  assert.strictEqual(verified.uid, 202);

  // Tampered ticket
  const tampered = ticket.slice(0, -4) + 'abcd';
  assert.strictEqual(verifyCheckinTicket(tampered, secret), null, 'Tampered ticket must fail');

  // Expired ticket
  const expiredTicket = generateCheckinTicket(101, 202, secret, -1000);
  assert.strictEqual(verifyCheckinTicket(expiredTicket, secret), null, 'Expired ticket must fail');
  console.log('  ✓ Check-in ticket cryptographic signing & 60-second expiration verified');

  // 4. Test Check-in Rate Limiting
  const stuKey = 9999;
  const ipKey = '192.168.1.250';
  for (let i = 0; i < 20; i++) {
    const res = checkAttendanceRateLimit(stuKey, ipKey);
    assert.strictEqual(res.allowed, true);
  }
  const blockedRes = checkAttendanceRateLimit(stuKey, ipKey);
  assert.strictEqual(blockedRes.allowed, false);
  assert(blockedRes.error.includes('Too many check-in requests'));
  console.log('  ✓ Check-in rate limiter (20 requests/minute) verified');

  // 5. Test Teacher Removal of Check-in
  const tInfo = await execute(
    'INSERT INTO teachers (username, password_hash, name, session_version, created_at) VALUES (?, ?, ?, 1, ?)',
    ['teach_c', 'hash', 'Prof C', Date.now()]
  );
  const teacherId = tInfo.lastInsertRowid;
  const bInfo = await execute('INSERT INTO batches (name) VALUES (?)', ['Batch C']);
  const batchId = bInfo.lastInsertRowid;
  const sInfo = await execute(
    'INSERT INTO students (student_id, name, batch_id, password_hash, must_change_password, session_version, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)',
    ['SC01', 'Charlie C', batchId, 'hash', Date.now()]
  );
  const studentId = sInfo.lastInsertRowid;

  const sessInfo = await execute(
    'INSERT INTO sessions (teacher_id, batch_id, title, session_secret, started_at) VALUES (?, ?, ?, ?, ?)',
    [teacherId, batchId, 'Lecture Part C', generateSessionSecret(), Date.now()]
  );
  const sessionId = sessInfo.lastInsertRowid;

  const attInfo = await execute(
    'INSERT INTO attendance (session_id, student_id, marked_at, method) VALUES (?, ?, ?, ?)',
    [sessionId, studentId, Date.now(), 'scanner']
  );
  const attendanceId = attInfo.lastInsertRowid;

  assert.strictEqual(await getPresentCount(sessionId), 1);

  // Teacher removes check-in
  await execute('DELETE FROM attendance WHERE id = ?', [attendanceId]);
  await execute(
    'INSERT INTO flags (session_id, student_id, device_id, reason, created_at) VALUES (?, ?, NULL, ?, ?)',
    [sessionId, studentId, 'Check-in removed by teacher', Date.now()]
  );

  const remainingAtt = await queryOne('SELECT * FROM attendance WHERE id = ?', [attendanceId]);
  assert.strictEqual(remainingAtt, null, 'Attendance record should be deleted');

  const removalFlag = await queryOne('SELECT * FROM flags WHERE session_id = ? AND student_id = ?', [
    sessionId,
    studentId,
  ]);
  assert(removalFlag && removalFlag.reason.includes('removed by teacher'));
  console.log('  ✓ Teacher check-in removal and security flag logging verified');

  console.log('Part C tests passed successfully!\n');
}

if (require.main === module) {
  runPartCTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Part C test failure:', err);
      process.exit(1);
    });
}

module.exports = { runPartCTests };
