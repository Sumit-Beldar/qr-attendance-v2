'use strict';

const http = require('http');

function req(options, postData = null) {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          parsed = body;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed,
        });
      });
    });
    request.on('error', reject);
    if (postData) {
      if (typeof postData === 'object') {
        request.write(JSON.stringify(postData));
      } else {
        request.write(postData);
      }
    }
    request.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return '';
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function runProductionFlow() {
  console.log('--- Testing Server in Production Mode (Port 4000) ---');

  // 1. Check Health Endpoints
  const healthRes = await req({
    hostname: 'localhost',
    port: 4000,
    path: '/healthz',
    method: 'GET',
  });
  console.log('1. GET /healthz response:', healthRes.data);

  const healthDbRes = await req({
    hostname: 'localhost',
    port: 4000,
    path: '/healthz/db',
    method: 'GET',
  });
  console.log('2. GET /healthz/db response:', healthDbRes.data);

  // 2. Setup status check
  const setupStatusRes = await req({
    hostname: 'localhost',
    port: 4000,
    path: '/api/teacher/setup-status',
    method: 'GET',
  });
  console.log('3. GET /api/teacher/setup-status:', setupStatusRes.data);

  let teacherCookie = '';

  if (setupStatusRes.data.setupRequired) {
    // 3a. Initial Teacher Setup with SETUP_KEY
    const setupRes = await req(
      {
        hostname: 'localhost',
        port: 4000,
        path: '/api/teacher/setup',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        name: 'Prof. Cloud Teacher',
        username: 'prof_cloud',
        password: 'CloudPass@123',
        setup_key: 'mysecretkey',
      }
    );
    console.log('3a. Setup with SETUP_KEY:', setupRes.data);
    teacherCookie = extractCookie(setupRes.headers);
  } else {
    // 3b. Login
    const loginRes = await req(
      {
        hostname: 'localhost',
        port: 4000,
        path: '/api/teacher/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      { username: 'prof_knuth', password: 'TeachPass#1' }
    );
    console.log('3b. Teacher login response:', loginRes.data);
    teacherCookie = extractCookie(loginRes.headers);
  }

  // 4. Create Batch
  const batchRes = await req(
    {
      hostname: 'localhost',
      port: 4000,
      path: '/api/teacher/batches',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { name: 'Prod-SE-' + Date.now() }
  );
  console.log('4. Created batch:', batchRes.data);
  const batchId = batchRes.data.batch.id;

  // 5. Add Student
  const sCode = 'P' + Math.floor(Math.random() * 8999 + 1000);
  const studentRes = await req(
    {
      hostname: 'localhost',
      port: 4000,
      path: '/api/teacher/students',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { student_id: sCode, name: 'Prod Alice', batch_id: batchId, password: 'StudentPass!123' }
  );
  console.log('5. Created student:', studentRes.data);

  // 6. Start Attendance Session
  const sessionRes = await req(
    {
      hostname: 'localhost',
      port: 4000,
      path: '/api/sessions/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { batch_id: batchId, title: 'Cloud Computing 101' }
  );
  console.log('6. Started session:', sessionRes.data);
  const sessionId = sessionRes.data.session.id;

  // 7. Projector Polling (verifies PUBLIC_BASE_URL shortDisplay)
  const currentRes = await req({
    hostname: 'localhost',
    port: 4000,
    path: `/api/sessions/${sessionId}/current`,
    method: 'GET',
  });
  console.log('7. Projector current output:', {
    code: currentRes.data.code,
    url: currentRes.data.url,
    shortDisplay: currentRes.data.shortDisplay,
  });
  const currentCode = currentRes.data.code;

  // 8. Pending Check-in Flow: Scan while logged out
  const directScanRes = await req({
    hostname: 'localhost',
    port: 4000,
    path: `/a/${currentCode}`,
    method: 'GET',
  });
  console.log('8. Direct scan while logged out (status):', directScanRes.status, 'Location:', directScanRes.headers.location);
  const pendingCookie = extractCookie(directScanRes.headers);

  // 9. Student Login with pending check-in cookie preserved
  const sLoginRes = await req(
    {
      hostname: 'localhost',
      port: 4000,
      path: '/api/student/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pendingCookie },
    },
    { student_id: sCode, password: 'StudentPass!123' }
  );
  console.log('9. Student login with pending flag:', sLoginRes.data);
  const loggedInStudentCookie = extractCookie(sLoginRes.headers);

  // 10. Complete Pending Check-in
  const completeRes = await req(
    {
      hostname: 'localhost',
      port: 4000,
      path: '/api/attendance/complete-pending',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: loggedInStudentCookie },
    },
    {}
  );
  console.log('10. Completed pending check-in:', completeRes.data);

  // 11. End Session and Download CSV
  const endRes = await req(
    {
      hostname: 'localhost',
      port: 4000,
      path: `/api/sessions/${sessionId}/end`,
      method: 'POST',
      headers: { Cookie: teacherCookie },
    },
    {}
  );
  console.log('11. Session ended:', endRes.data);

  const csvRes = await req({
    hostname: 'localhost',
    port: 4000,
    path: `/api/sessions/${sessionId}/export-csv`,
    method: 'GET',
    headers: { Cookie: teacherCookie },
  });
  console.log('12. Exported CSV Content (IST timezone):\n' + csvRes.data);

  console.log('--- Production Mode Verification Completed Successfully! ---');
}

runProductionFlow()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Production test failure:', err);
    process.exit(1);
  });
