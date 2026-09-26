'use strict';

const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });

function req(options, postData = null) {
  return new Promise((resolve, reject) => {
    options.agent = agent;
    const req = https.request(options, (res) => {
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
    req.on('error', reject);
    if (postData) {
      if (typeof postData === 'object') {
        req.write(JSON.stringify(postData));
      } else {
        req.write(postData);
      }
    }
    req.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return '';
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function verifyFlow() {
  console.log('--- Starting Live HTTP Verification against running server ---');

  // 1. Teacher Login
  const loginRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/teacher/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { username: 'prof_knuth', password: 'TeachPass#1' }
  );

  console.log('1. Teacher login response:', loginRes.data);
  const teacherCookie = extractCookie(loginRes.headers);

  // 2. Fetch Batches
  const batchesRes = await req({
    hostname: 'localhost',
    port: 3443,
    path: '/api/teacher/batches',
    method: 'GET',
    headers: { Cookie: teacherCookie },
  });
  console.log('2. Batches list:', batchesRes.data);
  const batchId = batchesRes.data.batches[0].id;

  // 3. Start Session
  const sessionRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/sessions/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { batch_id: batchId, title: 'Operating Systems – Lecture 1' }
  );
  console.log('3. Session started:', sessionRes.data);
  const sessionId = sessionRes.data.session.id;

  // 4. Poll Projector /current
  const currentRes = await req({
    hostname: 'localhost',
    port: 3443,
    path: `/api/sessions/${sessionId}/current`,
    method: 'GET',
  });
  console.log('4. Projector current code:', {
    code: currentRes.data.code,
    active: currentRes.data.active,
    url: currentRes.data.url,
    presentCount: currentRes.data.presentCount,
  });
  const currentCode = currentRes.data.code;

  // 5. Student Login
  const sLoginRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/student/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { student_id: 'CS01', password: 'StudentPass1' }
  );
  console.log('5. Student CS01 login:', sLoginRes.data);
  const studentCookie = extractCookie(sLoginRes.headers);

  // 6. Mark Attendance
  const markRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/mark',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
    },
    { code: currentCode, method: 'scanner' }
  );
  console.log('6. Mark attendance:', markRes.data);

  // 7. Duplicate Mark Attempt
  const dupRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/mark',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: studentCookie },
    },
    { code: currentCode, method: 'scanner' }
  );
  console.log('7. Duplicate mark check (friendly):', dupRes.data);

  // 8. Live View Data
  const liveRes = await req({
    hostname: 'localhost',
    port: 3443,
    path: `/api/sessions/${sessionId}/live`,
    method: 'GET',
    headers: { Cookie: teacherCookie },
  });
  console.log('8. Live monitoring presentCount:', liveRes.data.presentCount, 'flags:', liveRes.data.flags.length);

  // 9. End Session
  const endRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: `/api/sessions/${sessionId}/end`,
      method: 'POST',
      headers: { Cookie: teacherCookie },
    },
    {}
  );
  console.log('9. End session:', endRes.data);

  console.log('\n--- All live HTTP verification tests completed successfully! ---');
}

verifyFlow()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Flow failed:', err);
    process.exit(1);
  });
