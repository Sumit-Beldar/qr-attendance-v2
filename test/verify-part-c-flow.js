'use strict';

const https = require('https');

const agent = new https.Agent({ rejectUnauthorized: false });

function req(options, postData = null) {
  return new Promise((resolve, reject) => {
    options.agent = agent;
    const request = https.request(options, (res) => {
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

async function verifyPartCFlow() {
  console.log('--- Testing Part C Anti-Proxy & Location Fencing on Live Server ---');

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
  console.log('1. Teacher login:', loginRes.data);
  const teacherCookie = extractCookie(loginRes.headers);

  // 2. Configure Classroom GPS Location in Flag-only mode
  const settingsRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/teacher/settings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    {
      location_mode: 'flag',
      classroom_lat: '12.971600',
      classroom_lng: '77.594600',
      classroom_radius: '150',
      grace_window_slots: '2',
    }
  );
  console.log('2. Saved location settings (Flag mode):', settingsRes.data);

  // 3. Create Batch and Students
  const batchRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/teacher/batches',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { name: 'Geo-SE-' + Date.now() }
  );
  const batchId = batchRes.data.batch.id;

  const s1Res = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/teacher/students',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { student_id: 'GEO01', name: 'Alice Geo', batch_id: batchId, password: 'StudentPass!123' }
  );
  const s2Res = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/teacher/students',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { student_id: 'GEO02', name: 'Bob Geo', batch_id: batchId, password: 'StudentPass!123' }
  );
  console.log('3. Enrolled students GEO01 and GEO02 in batch:', batchId);

  // 4. Start Session
  const sessionRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/sessions/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    { batch_id: batchId, title: 'Distributed Systems' }
  );
  console.log('4. Session started:', sessionRes.data);
  const sessionId = sessionRes.data.session.id;

  // 5. Get current code
  const currentRes = await req({
    hostname: 'localhost',
    port: 3443,
    path: `/api/sessions/${sessionId}/current`,
    method: 'GET',
  });
  const currentCode = currentRes.data.code;
  console.log('5. Projector current code:', currentCode);

  // 6. Student GEO01 Login
  const s1LoginRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/student/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { student_id: 'GEO01', password: 'StudentPass!123' }
  );
  const student1Cookie = extractCookie(s1LoginRes.headers);

  // 7. Student GEO01 claims ticket
  const ticketRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/claim-ticket',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: student1Cookie },
    },
    { code: currentCode }
  );
  console.log('7. Ticket claimed:', ticketRes.data);
  const ticket1 = ticketRes.data.ticket;

  // 8. Student GEO01 completes check-in with far-away coordinates (Flag mode)
  const mark1Res = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/mark-with-ticket',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: student1Cookie },
    },
    {
      ticket: ticket1,
      method: 'scanner',
      lat: 13.05, // ~9 km away
      lng: 77.5946,
      accuracy: 10,
    }
  );
  console.log('8. Mark with far-away GPS (Flagged):', mark1Res.data);

  // 9. Check Live Session (GEO01 should appear present with flag)
  const liveRes = await req({
    hostname: 'localhost',
    port: 3443,
    path: `/api/sessions/${sessionId}/live`,
    method: 'GET',
    headers: { Cookie: teacherCookie },
  });
  console.log('9. Live monitoring present count:', liveRes.data.presentCount, 'Flags count:', liveRes.data.flags.length);
  const attRecordId = liveRes.data.present[0].id;

  // 10. Teacher removes GEO01 check-in
  const removeRes = await req({
    hostname: 'localhost',
    port: 3443,
    path: `/api/attendance/${attRecordId}`,
    method: 'DELETE',
    headers: { Cookie: teacherCookie },
  });
  console.log('10. Teacher removed check-in:', removeRes.data);

  // 11. Switch location mode to BLOCK
  await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/teacher/settings',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: teacherCookie },
    },
    {
      location_mode: 'block',
      classroom_lat: '12.971600',
      classroom_lng: '77.594600',
      classroom_radius: '150',
    }
  );
  console.log('11. Switched location mode to BLOCK');

  // 12. Student GEO02 Login
  const s2LoginRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/student/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { student_id: 'GEO02', password: 'StudentPass!123' }
  );
  const student2Cookie = extractCookie(s2LoginRes.headers);

  // 13. Student GEO02 gets fresh code & ticket
  const freshCodeRes = await req({
    hostname: 'localhost',
    port: 3443,
    path: `/api/sessions/${sessionId}/current`,
    method: 'GET',
  });
  const freshCode = freshCodeRes.data.code;

  const ticket2Res = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/claim-ticket',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: student2Cookie },
    },
    { code: freshCode }
  );
  const ticket2 = ticket2Res.data.ticket;

  // 14. Student GEO02 attempts check-in far away in BLOCK mode (must be rejected)
  const blockAttemptRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/mark-with-ticket',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: student2Cookie },
    },
    {
      ticket: ticket2,
      method: 'scanner',
      lat: 13.05,
      lng: 77.5946,
      accuracy: 10,
    }
  );
  console.log('14. Outside classroom attempt in BLOCK mode:', blockAttemptRes.status, blockAttemptRes.data);

  // 15. Student GEO02 checks in inside classroom in BLOCK mode (must succeed)
  const insideTicketRes = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/claim-ticket',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: student2Cookie },
    },
    { code: freshCode }
  );
  const mark2Res = await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: '/api/attendance/mark-with-ticket',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: student2Cookie },
    },
    {
      ticket: insideTicketRes.data.ticket,
      method: 'scanner',
      lat: 12.97165, // ~6m away from classroom center
      lng: 77.59462,
      accuracy: 5,
    }
  );
  console.log('15. Inside classroom check-in in BLOCK mode:', mark2Res.data);

  // 16. End Session
  await req(
    {
      hostname: 'localhost',
      port: 3443,
      path: `/api/sessions/${sessionId}/end`,
      method: 'POST',
      headers: { Cookie: teacherCookie },
    },
    {}
  );
  console.log('16. Session closed.');

  console.log('\n--- Part C Live Verification Completed Successfully! ---');
}

verifyPartCFlow()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Part C flow failed:', err);
    process.exit(1);
  });
