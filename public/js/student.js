// Student Mobile Client Script

let html5QrScanner = null;
let currentStudent = null;
let isSubmitting = false;

// Toast helper
function showToast(message, duration = 3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// Modal helpers
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

document.querySelectorAll('.modal-close').forEach((b) => {
  b.addEventListener('click', () => {
    b.closest('.modal-backdrop').style.display = 'none';
  });
});

// Format timestamp to local 10:02 AM, 26 Sep 2026
function formatDateTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  return `${timeStr}, ${dateStr}`;
}

// Format time only (10:02 AM)
function formatTimeOnly(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Initialization
async function init() {
  const params = new URLSearchParams(window.location.search);
  const isPendingParam = params.get('pending') === '1';

  try {
    const res = await fetch('/api/student/status');
    const data = await res.json();

    document.getElementById('view-loading').style.display = 'none';

    if (!data.loggedIn) {
      showLogin(isPendingParam || data.hasPendingCheckin);
      return;
    }

    currentStudent = data.student;

    if (data.student.must_change_password) {
      showChangePassword();
      return;
    }

    // If logged in and has pending check-in from direct camera scan
    if (data.hasPendingCheckin || isPendingParam) {
      await processPendingCheckin();
      return;
    }

    showMain();
  } catch (err) {
    document.getElementById('view-loading').innerHTML = `
      <div class="alert alert-error">
        Couldn't reach the server. Check you're on the same Wi-Fi.
      </div>
    `;
  }
}

function showLogin(showPendingNotice = false) {
  document.getElementById('view-main').style.display = 'none';
  document.getElementById('view-change-password').style.display = 'none';
  document.getElementById('view-success').style.display = 'none';
  document.getElementById('view-login').style.display = 'block';

  if (showPendingNotice) {
    document.getElementById('pending-checkin-alert').style.display = 'block';
  } else {
    document.getElementById('pending-checkin-alert').style.display = 'none';
  }
}

function showChangePassword() {
  document.getElementById('view-login').style.display = 'none';
  document.getElementById('view-main').style.display = 'none';
  document.getElementById('view-success').style.display = 'none';
  document.getElementById('view-change-password').style.display = 'block';
}

function showMain() {
  document.getElementById('view-login').style.display = 'none';
  document.getElementById('view-change-password').style.display = 'none';
  document.getElementById('view-success').style.display = 'none';
  document.getElementById('view-main').style.display = 'block';

  document.getElementById('disp-student-name').textContent = currentStudent.name;
  document.getElementById('disp-student-id').textContent = currentStudent.student_id;
  document.getElementById('disp-batch-name').textContent = currentStudent.batch_name;

  loadRecentAttendance();
}

function showSuccess(result) {
  document.getElementById('view-login').style.display = 'none';
  document.getElementById('view-change-password').style.display = 'none';
  document.getElementById('view-main').style.display = 'none';
  document.getElementById('view-scanner').style.display = 'none';
  document.getElementById('view-success').style.display = 'block';

  const headline = document.getElementById('success-headline');
  if (result.alreadyMarked) {
    headline.textContent = 'Already marked present';
    headline.style.color = 'var(--muted)';
  } else {
    headline.textContent = "You're marked present";
    headline.style.color = 'var(--accent)';
  }

  document.getElementById('success-subject').textContent = result.session.title;
  document.getElementById('success-time').textContent = formatDateTime(result.markedAt);

  // Vibration feedback
  try {
    if (navigator.vibrate) {
      navigator.vibrate(100);
    }
  } catch (e) {
    // ignore
  }
}

// Login form
document.getElementById('form-student-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('login-alert');
  const btn = document.getElementById('btn-login-submit');
  alertEl.style.display = 'none';
  btn.disabled = true;

  const student_id = document.getElementById('student-id-input').value;
  const password = document.getElementById('student-pass-input').value;

  try {
    const res = await fetch('/api/student/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id, password }),
    });
    const data = await res.json();
    btn.disabled = false;

    if (!data.ok) {
      alertEl.textContent = data.error;
      alertEl.style.display = 'block';
      return;
    }

    currentStudent = data.student;

    if (data.student.must_change_password) {
      showChangePassword();
      return;
    }

    if (data.hasPendingCheckin) {
      await processPendingCheckin();
      return;
    }

    showMain();
  } catch (err) {
    btn.disabled = false;
    alertEl.textContent = 'Connection error. Please try again.';
    alertEl.style.display = 'block';
  }
});

// Force Password Change Form
document.getElementById('form-force-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('change-pass-alert');
  alertEl.style.display = 'none';

  const newPass = document.getElementById('new-pass-input').value;
  const confirmPass = document.getElementById('confirm-pass-input').value;

  if (newPass !== confirmPass) {
    alertEl.textContent = 'Passwords do not match';
    alertEl.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/student/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: newPass }),
    });
    const data = await res.json();
    if (!data.ok) {
      alertEl.textContent = data.error;
      alertEl.style.display = 'block';
      return;
    }

    showToast('Password updated');
    currentStudent.must_change_password = false;

    // Check if pending checkin was queued
    await processPendingCheckin();
  } catch (err) {
    alertEl.textContent = 'Error updating password';
    alertEl.style.display = 'block';
  }
});

// Geolocation Helper
function getStudentPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      return resolve({ locationError: 'unavailable' });
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        resolve({ locationError: err.code === 1 ? 'denied' : 'timeout' });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// Pending check-in completion
async function processPendingCheckin() {
  try {
    const locPayload = await getStudentPosition();
    const res = await fetch('/api/attendance/complete-pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(locPayload),
    });
    const data = await res.json();
    if (data.ok) {
      showSuccess(data);
      return;
    }
  } catch (e) {
    console.warn('No pending checkin completed');
  }
  showMain();
}

// Recent attendance history
async function loadRecentAttendance() {
  const container = document.getElementById('recent-attendance-list');
  try {
    const res = await fetch('/api/student/recent');
    const data = await res.json();
    if (data.ok && data.recent && data.recent.length > 0) {
      container.innerHTML = data.recent
        .map(
          (r) => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border);">
            <div>
              <div style="font-weight: 500; font-size: 15px; color: var(--ink);">${escapeHtml(r.title)}</div>
              <div class="text-sm text-muted tabular">${formatDateTime(r.marked_at)}</div>
            </div>
            <span class="student-badge" style="background: var(--success-bg); color: var(--accent); font-weight: 600;">Present</span>
          </div>
        `
        )
        .join('');
    } else {
      container.innerHTML = '<p class="text-sm text-muted">No attendance recorded yet.</p>';
    }
  } catch (e) {
    container.innerHTML = '<p class="text-sm text-muted">Could not load recent attendance.</p>';
  }
}

// ==========================================
// QR SCANNER LOGIC
// ==========================================

document.getElementById('btn-open-scanner').addEventListener('click', () => {
  // Check HTTPS
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    alert('Camera access requires HTTPS. Please connect via https://');
    return;
  }

  startScanner();
});

function startScanner() {
  document.getElementById('view-scanner').style.display = 'flex';

  if (!html5QrScanner) {
    html5QrScanner = new Html5Qrcode('reader');
  }

  const qrConfig = {
    fps: 10,
    qrbox: (viewfinderWidth, viewfinderHeight) => {
      const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
      const edge = Math.floor(minEdge * 0.7);
      return { width: edge, height: edge };
    },
    aspectRatio: 1.0,
  };

  html5QrScanner
    .start(
      { facingMode: 'environment' },
      qrConfig,
      onScanSuccess,
      onScanFailure
    )
    .catch((err) => {
      console.error('Camera start error:', err);
      stopScanner();
      alert('Could not start camera. Please check camera permissions or use "Enter code manually".');
    });
}

function stopScanner() {
  if (html5QrScanner && html5QrScanner.isScanning) {
    html5QrScanner.stop().then(() => {
      document.getElementById('view-scanner').style.display = 'none';
    }).catch(() => {
      document.getElementById('view-scanner').style.display = 'none';
    });
  } else {
    document.getElementById('view-scanner').style.display = 'none';
  }
}

document.getElementById('btn-close-scanner').addEventListener('click', stopScanner);

function extractCodeFromScan(decodedText) {
  if (!decodedText) return '';
  const trimmed = decodedText.trim();
  const match = trimmed.match(/\/a\/([A-Za-z0-9]{6})/i);
  if (match && match[1]) {
    return match[1].toUpperCase();
  }
  if (/^[A-Za-z0-9]{6}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

async function onScanSuccess(decodedText) {
  if (isSubmitting) return;
  isSubmitting = true;

  stopScanner();

  const code = extractCodeFromScan(decodedText);
  await submitAttendanceCode(code, 'scanner');
  isSubmitting = false;
}

function onScanFailure(error) {
  // Ignored for continuous frame scanning
}

// ==========================================
// ATTENDANCE SUBMISSION (2-STEP TICKET FLOW)
// ==========================================

async function submitAttendanceCode(code, method = 'manual') {
  const alertEl = document.getElementById('main-alert');
  alertEl.style.display = 'none';

  try {
    // Step 1: Claim signed check-in ticket (validates 7-second code instantly)
    const claimRes = await fetch('/api/attendance/claim-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const claimData = await claimRes.json();
    if (!claimData.ok) {
      alertEl.textContent = claimData.error || 'Failed to mark attendance';
      alertEl.style.display = 'block';
      showToast(claimData.error || 'Check-in failed');
      return;
    }

    const { ticket, locationRequired } = claimData;
    let locPayload = {};

    // Step 2: Acquire GPS location if classroom location check is active
    if (locationRequired) {
      locPayload = await getStudentPosition();
    }

    // Step 3: Complete check-in with ticket
    const markRes = await fetch('/api/attendance/mark-with-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        method,
        ...locPayload,
      }),
    });

    const markData = await markRes.json();
    if (!markData.ok) {
      alertEl.textContent = markData.error || 'Failed to mark attendance';
      alertEl.style.display = 'block';
      showToast(markData.error || 'Check-in failed');
      return;
    }

    showSuccess(markData);
  } catch (err) {
    alertEl.textContent = 'Connection error. Please check your network and try again.';
    alertEl.style.display = 'block';
  }
}

// Manual Code Entry
document.getElementById('btn-open-manual').addEventListener('click', () => {
  document.getElementById('manual-code-alert').style.display = 'none';
  document.getElementById('form-manual-code').reset();
  openModal('modal-manual-code');
});

const manualInput = document.getElementById('manual-code-input');
manualInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

document.getElementById('form-manual-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = manualInput.value.trim();
  if (code.length !== 6) {
    const alertEl = document.getElementById('manual-code-alert');
    alertEl.textContent = 'Code must be exactly 6 characters';
    alertEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-manual-submit');
  btn.disabled = true;

  closeModal('modal-manual-code');
  await submitAttendanceCode(code, 'manual');
  btn.disabled = false;
});

// Success Done button
document.getElementById('btn-success-done').addEventListener('click', () => {
  showMain();
});

// Account Settings Modal
document.getElementById('btn-account-modal').addEventListener('click', () => {
  document.getElementById('account-alert').style.display = 'none';
  document.getElementById('form-account-pass').reset();
  openModal('modal-account');
});

document.getElementById('form-account-pass').addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('account-alert');
  alertEl.style.display = 'none';

  const current_password = document.getElementById('acc-curr-pass').value;
  const new_password = document.getElementById('acc-new-pass').value;

  try {
    const res = await fetch('/api/student/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password }),
    });
    const data = await res.json();
    if (!data.ok) {
      alertEl.textContent = data.error;
      alertEl.style.display = 'block';
      return;
    }

    closeModal('modal-account');
    showToast('Password changed successfully');
  } catch (err) {
    alertEl.textContent = 'Error changing password';
    alertEl.style.display = 'block';
  }
});

// Student Logout
document.getElementById('btn-student-logout').addEventListener('click', async () => {
  await fetch('/api/student/logout', { method: 'POST' });
  window.location.reload();
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Start
init();
