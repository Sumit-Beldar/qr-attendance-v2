'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieSession = require('cookie-session');
const { query, queryOne, execute, batch, runMigrations } = require('../src/db');
const teacherRoutes = require('../src/routes/teacher');

function formatCookies(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function testTeacherAccountsFlow() {
  console.log('Testing Teacher Accounts HTTP API...');
  await runMigrations();

  const app = express();
  app.use(express.json());
  app.use(
    cookieSession({
      name: 'session',
      keys: ['test-secret-key-that-is-at-least-32-chars-long!'],
    })
  );

  app.use('/api/teacher', teacherRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Create initial teacher directly or log in
    await execute('DELETE FROM teachers WHERE username = ?', ['test_admin_teacher']);
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('AdminPass@123', 10);
    const ins = await execute(
      'INSERT INTO teachers (username, password_hash, name, session_version, created_at) VALUES (?, ?, ?, 1, ?)',
      ['test_admin_teacher', hash, 'Admin Teacher', Date.now()]
    );

    // Login as admin teacher to get session cookie
    const loginRes = await fetch(`${baseUrl}/api/teacher/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test_admin_teacher', password: 'AdminPass@123' }),
    });
    assert.strictEqual(loginRes.status, 200);
    const cookie = formatCookies(loginRes);
    assert(cookie, 'Cookie must be returned on login');

    // 2. GET /api/teacher/accounts
    const listRes = await fetch(`${baseUrl}/api/teacher/accounts`, {
      headers: { Cookie: cookie },
    });
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert(listData.ok);
    assert(Array.isArray(listData.teachers));
    const initialCount = listData.teachers.length;

    // 3. POST /api/teacher/accounts (Create a second teacher)
    const newUsername = 'second_prof_' + Date.now();
    const createRes = await fetch(`${baseUrl}/api/teacher/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Prof. Margaret Hamilton',
        username: newUsername,
        password: 'SecondTeacherPass@123',
      }),
    });
    assert.strictEqual(createRes.status, 200);
    const createData = await createRes.json();
    assert(createData.ok);
    assert(createData.teacher.id > 0);
    const secondTeacherId = createData.teacher.id;

    // 4. Verify second teacher can log in
    const secondLoginRes = await fetch(`${baseUrl}/api/teacher/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, password: 'SecondTeacherPass@123' }),
    });
    assert.strictEqual(secondLoginRes.status, 200);
    const secondLoginData = await secondLoginRes.json();
    assert(secondLoginData.ok);
    assert.strictEqual(secondLoginData.teacher.username, newUsername);

    // 5. Reset second teacher's password
    const resetRes = await fetch(`${baseUrl}/api/teacher/accounts/${secondTeacherId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ new_password: 'EvenNewerPassword@456' }),
    });
    assert.strictEqual(resetRes.status, 200);
    const resetData = await resetRes.json();
    assert(resetData.ok);

    // 6. Verify old password fails and new password works
    const failLoginRes = await fetch(`${baseUrl}/api/teacher/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, password: 'SecondTeacherPass@123' }),
    });
    assert.strictEqual(failLoginRes.status, 401);

    const newPassLoginRes = await fetch(`${baseUrl}/api/teacher/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, password: 'EvenNewerPassword@456' }),
    });
    assert.strictEqual(newPassLoginRes.status, 200);

    // 7. Delete second teacher
    const deleteRes = await fetch(`${baseUrl}/api/teacher/accounts/${secondTeacherId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.strictEqual(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert(deleteData.ok);

    console.log('✓ All Teacher Accounts HTTP API endpoints verified successfully!');
  } finally {
    server.close();
  }
}

testTeacherAccountsFlow().catch((err) => {
  console.error('Teacher Accounts API test failed:', err);
  process.exit(1);
});
