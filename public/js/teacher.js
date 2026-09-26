// Teacher Portal JavaScript

const state = {
  activeTab: 'students',
  batches: [],
  students: [],
  csvValidRows: [],
  settings: {},
};

// UI Helper: Toast Notifications
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

// UI Helper: Modal controls
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.style.display = 'flex';
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.style.display = 'none';
}

document.querySelectorAll('.modal-close').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.closest('.modal-backdrop').style.display = 'none';
  });
});

// App Initialization
async function init() {
  try {
    const res = await fetch('/api/teacher/setup-status');
    const data = await res.json();

    document.getElementById('view-loading').style.display = 'none';

    if (data.setupRequired) {
      if (data.requiresSetupKey) {
        const keyGroup = document.getElementById('group-setup-key');
        if (keyGroup) keyGroup.style.display = 'block';
      }
      document.getElementById('view-setup').style.display = 'block';
    } else if (!data.loggedIn) {
      document.getElementById('view-login').style.display = 'block';
    } else {
      showApp();
    }
  } catch (err) {
    document.getElementById('view-loading').innerHTML = `
      <div class="alert alert-error">
        Failed to connect to the server. Check your network or reload the page.
      </div>
    `;
  }
}

function showApp() {
  document.getElementById('view-setup').style.display = 'none';
  document.getElementById('view-login').style.display = 'none';
  document.getElementById('main-nav').style.display = 'block';
  document.getElementById('view-app').style.display = 'block';

  // Handle URL hash navigation
  handleHashNavigation();
  window.addEventListener('hashchange', handleHashNavigation);

  // Initial data loading
  loadBatches();
  loadStudents();
  loadSettings();
}

// Navigation Tabs
function handleHashNavigation() {
  const hash = window.location.hash.replace('#', '') || 'students';
  switchTab(hash);
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.app-section').forEach((sec) => (sec.style.display = 'none'));
  document.querySelectorAll('.nav-link').forEach((link) => link.classList.remove('active'));

  const activeSec = document.getElementById(`section-${tabName}`);
  const activeNav = document.getElementById(`nav-${tabName}`);
  if (activeSec) activeSec.style.display = 'block';
  if (activeNav) activeNav.classList.add('active');

  if (tabName === 'students') {
    stopLivePolling();
    loadBatches();
    loadStudents();
  } else if (tabName === 'start') {
    stopLivePolling();
    loadBatches();
    checkActiveSession();
  } else if (tabName === 'live') {
    startLivePolling();
  } else if (tabName === 'history') {
    stopLivePolling();
    loadHistory();
  } else if (tabName === 'settings') {
    stopLivePolling();
    loadSettings();
    loadStudentLinkQr();
    loadTeacherAccounts();
  }
}

// ==========================================
// LIVE SESSION MONITORING
// ==========================================

let livePollTimer = null;
let currentLiveSessionId = null;
let liveSubTab = 'present'; // 'present' | 'absent'

function startLivePolling() {
  stopLivePolling();
  pollLiveSession();
  livePollTimer = setInterval(pollLiveSession, 2000);
}

function stopLivePolling() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

async function pollLiveSession() {
  // First check if active session exists
  try {
    const activeRes = await fetch('/api/sessions/active');
    const activeData = await activeRes.json();

    if (!activeData.ok || !activeData.activeSession) {
      document.getElementById('live-no-session').style.display = 'block';
      document.getElementById('live-active-container').style.display = 'none';
      return;
    }

    currentLiveSessionId = activeData.activeSession.id;
    document.getElementById('live-no-session').style.display = 'none';
    document.getElementById('live-active-container').style.display = 'block';

    const liveRes = await fetch(`/api/sessions/${currentLiveSessionId}/live`);
    const data = await liveRes.json();
    if (!data.ok) return;

    renderLiveMonitoring(data);
  } catch (err) {
    console.warn('Failed to poll live session:', err);
  }
}

function renderLiveMonitoring(data) {
  document.getElementById('live-session-title').textContent = data.session.title;
  document.getElementById('live-session-meta').textContent = `Batch: ${data.session.batch_name} • Started: ${formatDateTime(data.session.started_at)}`;
  document.getElementById('live-stat-present').textContent = data.presentCount;
  document.getElementById('live-stat-total').textContent = data.totalStudents;
  document.getElementById('count-tab-present').textContent = data.present.length;
  document.getElementById('count-tab-absent').textContent = data.absent.length;

  // Render Flags if any
  const flagsBanner = document.getElementById('live-flags-banner');
  if (data.flags && data.flags.length > 0) {
    flagsBanner.style.display = 'block';
    document.getElementById('live-flags-title').textContent = `${data.flags.length} Proxy Attendance Warning${data.flags.length > 1 ? 's' : ''} Detected`;
    document.getElementById('live-flags-list').innerHTML = data.flags
      .map(
        (f) => `<div>• Student <strong>${escapeHtml(f.student_id)}</strong> (${escapeHtml(f.name)}): ${escapeHtml(f.reason)} at ${formatDateTime(f.created_at)}</div>`
      )
      .join('');
  } else {
    flagsBanner.style.display = 'none';
  }

  // Create student flag lookup map
  const flagMap = new Map();
  (data.flags || []).forEach((f) => flagMap.set(f.student_id, f.reason));

  // Render Present Table
  const presentBody = document.getElementById('table-present-body');
  if (data.present.length === 0) {
    presentBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--muted); padding: 24px;">No students have checked in yet.</td></tr>';
  } else {
    presentBody.innerHTML = data.present
      .map((p) => {
        const flagReason = flagMap.get(p.student_id);
        const flagBadge = flagReason
          ? `<span class="badge badge-warning" title="${escapeHtml(flagReason)}" style="margin-left: 6px;">Flagged: ${escapeHtml(flagReason)}</span>`
          : '';
        return `
        <tr>
          <td><strong class="tabular">${escapeHtml(p.student_id)}</strong></td>
          <td>${escapeHtml(p.name)} ${flagBadge}</td>
          <td class="tabular">${formatDateTime(p.marked_at)}</td>
          <td><span class="badge badge-success">${escapeHtml(p.method || 'scanner')}</span></td>
          <td style="text-align: right;">
            <button class="btn btn-secondary" style="padding: 2px 8px; min-height: 28px; font-size: 12px; color: var(--error);" onclick="window.removeAttendance(${p.id}, '${escapeHtml(p.student_id)}', '${escapeHtml(p.name)}')">Remove</button>
          </td>
        </tr>
      `;
      })
      .join('');
  }

  // Render Absent Table
  const absentBody = document.getElementById('table-absent-body');
  if (data.absent.length === 0) {
    absentBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--accent); padding: 24px;">All students in this batch are marked present!</td></tr>';
  } else {
    absentBody.innerHTML = data.absent
      .map(
        (a) => `
        <tr>
          <td><strong class="tabular">${escapeHtml(a.student_id)}</strong></td>
          <td>${escapeHtml(a.name)}</td>
          <td><span class="badge badge-warning">Unmarked</span></td>
        </tr>
      `
      )
      .join('');
  }
}

// Live Sub-tab switching
document.getElementById('tab-btn-present').addEventListener('click', () => {
  liveSubTab = 'present';
  document.getElementById('tab-btn-present').classList.add('active');
  document.getElementById('tab-btn-absent').classList.remove('active');
  document.getElementById('container-table-present').style.display = 'block';
  document.getElementById('container-table-absent').style.display = 'none';
});

document.getElementById('tab-btn-absent').addEventListener('click', () => {
  liveSubTab = 'absent';
  document.getElementById('tab-btn-absent').classList.add('active');
  document.getElementById('tab-btn-present').classList.remove('active');
  document.getElementById('container-table-absent').style.display = 'block';
  document.getElementById('container-table-present').style.display = 'none';
});

document.getElementById('btn-live-open-projector').addEventListener('click', () => {
  if (currentLiveSessionId) {
    window.open(`/projector/${currentLiveSessionId}`, '_blank');
  }
});

document.getElementById('btn-live-end-session').addEventListener('click', async () => {
  if (!currentLiveSessionId) return;
  const confirmed = confirm('Are you sure you want to end this attendance session? Students will no longer be able to check in.');
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/sessions/${currentLiveSessionId}/end`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('Session ended');
      pollLiveSession();
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Failed to end session');
  }
});

// ==========================================
// HISTORY & CSV EXPORTS
// ==========================================

async function loadHistory() {
  const tbody = document.getElementById('history-table-body');
  try {
    const res = await fetch('/api/sessions/history');
    const data = await res.json();

    if (!data.ok || !data.sessions || data.sessions.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 32px 16px; color: var(--muted);">
            No attendance sessions recorded yet. Start a session to see history.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = data.sessions
      .map(
        (s) => `
        <tr>
          <td class="tabular">${formatDateTime(s.started_at)}</td>
          <td><strong>${escapeHtml(s.title)}</strong></td>
          <td><span class="badge">${escapeHtml(s.batch_name)}</span></td>
          <td class="tabular">
            <strong>${s.present_count}</strong> / ${s.total_students}
            <span class="text-sm text-muted">(${s.total_students > 0 ? Math.round((s.present_count / s.total_students) * 100) : 0}%)</span>
          </td>
          <td>
            ${
              s.flag_count > 0
                ? `<span class="badge badge-warning">${s.flag_count} Flag${s.flag_count > 1 ? 's' : ''}</span>`
                : '<span class="text-sm text-muted">None</span>'
            }
          </td>
          <td style="text-align: right;">
            <a href="/api/sessions/${s.id}/export-csv" class="btn btn-secondary" style="padding: 4px 10px; font-size: 13px; min-height: 28px;" download>Download CSV</a>
          </td>
        </tr>
      `
      )
      .join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--error); padding: 16px;">Failed to load history</td></tr>';
  }
}

// ==========================================
// STUDENT LINK QR CODE
// ==========================================

async function loadStudentLinkQr() {
  const box = document.getElementById('student-link-qr-box');
  const dispUrl = document.getElementById('disp-student-url');

  try {
    const res = await fetch('/api/sessions/student-link-qr');
    const data = await res.json();
    if (data.ok) {
      box.innerHTML = data.qrSvg;
      dispUrl.textContent = data.url;
    }
  } catch (err) {
    box.innerHTML = '<p class="text-sm text-muted">Failed to load QR</p>';
  }
}

function formatDateTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  return `${timeStr}, ${dateStr}`;
}

// Check Active Session
let activeSessionData = null;
async function checkActiveSession() {
  try {
    const res = await fetch('/api/sessions/active');
    const data = await res.json();
    const banner = document.getElementById('active-session-banner');

    if (data.ok && data.activeSession) {
      activeSessionData = data.activeSession;
      document.getElementById('active-banner-title').textContent = data.activeSession.title;
      document.getElementById('active-banner-meta').textContent = `Batch: ${data.activeSession.batch_name} • Present: ${data.activeSession.present_count} / ${data.activeSession.total_students}`;
      banner.style.display = 'block';
    } else {
      activeSessionData = null;
      banner.style.display = 'none';
    }
  } catch (err) {
    console.warn('Error checking active session:', err);
  }
}

document.getElementById('btn-resume-projector').addEventListener('click', () => {
  if (activeSessionData) {
    window.open(`/projector/${activeSessionData.id}`, '_blank');
  }
});

document.getElementById('btn-end-active-session').addEventListener('click', async () => {
  if (!activeSessionData) return;
  const confirmed = confirm(`Are you sure you want to end attendance for "${activeSessionData.title}"?`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/sessions/${activeSessionData.id}/end`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('Session ended');
      checkActiveSession();
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Failed to end session');
  }
});

// Start Session Form
document.getElementById('form-start-session').addEventListener('submit', async (e) => {
  e.preventDefault();
  const batch_id = document.getElementById('session-batch-select').value;
  const title = document.getElementById('session-title-input').value;
  const btn = document.getElementById('btn-start-submit');

  if (!batch_id || !title.trim()) {
    showToast('Please select a batch and enter a lecture title');
    return;
  }

  btn.disabled = true;

  try {
    const res = await fetch('/api/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch_id, title: title.trim() }),
    });
    const data = await res.json();
    btn.disabled = false;

    if (!data.ok) {
      showToast(data.error);
      return;
    }

    showToast(`Session started: ${data.session.title}`);
    document.getElementById('session-title-input').value = '';
    // Open projector in new tab
    window.open(`/projector/${data.session.id}`, '_blank');
    checkActiveSession();
  } catch (err) {
    btn.disabled = false;
    showToast('Failed to start session');
  }
});

// Setup Form Submission
document.getElementById('form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('setup-alert');
  alertEl.style.display = 'none';

  const name = document.getElementById('setup-name').value;
  const username = document.getElementById('setup-username').value;
  const password = document.getElementById('setup-password').value;
  const setupKeyEl = document.getElementById('setup-key');
  const setup_key = setupKeyEl ? setupKeyEl.value : '';

  try {
    const res = await fetch('/api/teacher/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, password, setup_key }),
    });
    const data = await res.json();
    if (!data.ok) {
      alertEl.textContent = data.error;
      alertEl.style.display = 'block';
      return;
    }
    showToast('Teacher account created successfully');
    showApp();
  } catch (err) {
    alertEl.textContent = 'Server connection error. Please try again.';
    alertEl.style.display = 'block';
  }
});

// Login Form Submission
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('login-alert');
  const btnSubmit = document.getElementById('btn-login-submit');
  alertEl.style.display = 'none';
  btnSubmit.disabled = true;

  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/teacher/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    btnSubmit.disabled = false;

    if (!data.ok) {
      alertEl.textContent = data.error;
      alertEl.style.display = 'block';
      return;
    }
    showToast(`Welcome back, ${data.teacher.name}`);
    showApp();
  } catch (err) {
    btnSubmit.disabled = false;
    alertEl.textContent = 'Connection error. Please try again.';
    alertEl.style.display = 'block';
  }
});

// Logout
document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/teacher/logout', { method: 'POST' });
  window.location.reload();
});

// ==========================================
// BATCHES
// ==========================================

async function loadBatches() {
  try {
    const res = await fetch('/api/teacher/batches');
    const data = await res.json();
    if (data.ok) {
      state.batches = data.batches;
      renderBatchSelects();
      renderBatchesTable();
    }
  } catch (err) {
    console.error('Failed to load batches:', err);
  }
}

function renderBatchSelects() {
  const filterSelect = document.getElementById('student-batch-filter');
  const addSelect = document.getElementById('add-student-batch');
  const sessionSelect = document.getElementById('session-batch-select');

  const currentFilterVal = filterSelect.value;
  const currentSessionVal = sessionSelect ? sessionSelect.value : '';

  filterSelect.innerHTML = '<option value="">All Batches</option>';
  addSelect.innerHTML = '<option value="">Select a batch...</option>';
  if (sessionSelect) {
    sessionSelect.innerHTML = '<option value="">Select class / batch...</option>';
  }

  state.batches.forEach((b) => {
    const opt1 = document.createElement('option');
    opt1.value = b.id;
    opt1.textContent = `${b.name} (${b.student_count})`;
    filterSelect.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = b.id;
    opt2.textContent = b.name;
    addSelect.appendChild(opt2);

    if (sessionSelect) {
      const opt3 = document.createElement('option');
      opt3.value = b.id;
      opt3.textContent = `${b.name} (${b.student_count} students)`;
      sessionSelect.appendChild(opt3);
    }
  });

  filterSelect.value = currentFilterVal;
  if (sessionSelect && currentSessionVal) {
    sessionSelect.value = currentSessionVal;
  }
}

function renderBatchesTable() {
  const tbody = document.getElementById('batches-table-body');
  if (state.batches.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--muted); padding: 16px;">No batches created yet.</td></tr>';
    return;
  }

  tbody.innerHTML = state.batches
    .map(
      (b) => `
      <tr>
        <td><strong>${escapeHtml(b.name)}</strong></td>
        <td><span class="badge">${b.student_count} student${b.student_count === 1 ? '' : 's'}</span></td>
        <td style="text-align: right;">
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 13px; min-height: 28px;" onclick="promptRenameBatch(${b.id}, '${escapeHtml(b.name)}')">Rename</button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 13px; min-height: 28px; margin-left: 4px;" onclick="deleteBatch(${b.id}, '${escapeHtml(b.name)}', ${b.student_count})">Delete</button>
        </td>
      </tr>
    `
    )
    .join('');
}

document.getElementById('btn-open-batches').addEventListener('click', () => {
  renderBatchesTable();
  openModal('modal-batches');
});

document.getElementById('form-create-batch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('new-batch-name');
  const name = input.value.trim();
  if (!name) return;

  try {
    const res = await fetch('/api/teacher/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error);
      return;
    }
    input.value = '';
    showToast(`Batch "${name}" created`);
    loadBatches();
  } catch (err) {
    showToast('Failed to create batch');
  }
});

window.promptRenameBatch = async function (id, currentName) {
  const newName = prompt(`Rename batch "${currentName}":`, currentName);
  if (!newName || newName.trim() === '' || newName.trim() === currentName) return;

  try {
    const res = await fetch(`/api/teacher/batches/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error);
      return;
    }
    showToast('Batch renamed successfully');
    loadBatches();
    loadStudents();
  } catch (err) {
    showToast('Error renaming batch');
  }
};

window.deleteBatch = async function (id, name, studentCount) {
  if (studentCount > 0) {
    alert(`Cannot delete "${name}" because it still contains ${studentCount} students. Remove or reassign them first.`);
    return;
  }
  if (!confirm(`Are you sure you want to delete batch "${name}"?`)) return;

  try {
    const res = await fetch(`/api/teacher/batches/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error);
      return;
    }
    showToast(`Batch "${name}" deleted`);
    loadBatches();
  } catch (err) {
    showToast('Error deleting batch');
  }
};

// ==========================================
// STUDENTS
// ==========================================

async function loadStudents() {
  const batchId = document.getElementById('student-batch-filter').value;
  const search = document.getElementById('student-search-input').value;

  const params = new URLSearchParams();
  if (batchId) params.append('batch_id', batchId);
  if (search) params.append('search', search);

  try {
    const res = await fetch(`/api/teacher/students?${params.toString()}`);
    const data = await res.json();
    if (data.ok) {
      state.students = data.students;
      renderStudentsTable();
    }
  } catch (err) {
    console.error('Failed to load students:', err);
  }
}

document.getElementById('student-batch-filter').addEventListener('change', loadStudents);
document.getElementById('student-search-input').addEventListener('input', debounce(loadStudents, 300));

function renderStudentsTable() {
  const tbody = document.getElementById('students-table-body');
  if (state.students.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 32px 16px; color: var(--muted);">
          No students found. Add a single student or import a CSV list.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = state.students
    .map(
      (s) => `
      <tr>
        <td><strong class="tabular">${escapeHtml(s.student_id)}</strong></td>
        <td>${escapeHtml(s.name)}</td>
        <td><span class="badge">${escapeHtml(s.batch_name)}</span></td>
        <td>
          ${
            s.must_change_password === 1
              ? '<span class="badge badge-warning">Temp Password</span>'
              : '<span class="badge badge-success">Active</span>'
          }
        </td>
        <td style="text-align: right;">
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 13px; min-height: 28px;" onclick="openResetPasswordModal(${s.id}, '${escapeHtml(s.student_id)}', '${escapeHtml(s.name)}')">Reset Password</button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 13px; min-height: 28px; margin-left: 4px;" onclick="deleteStudent(${s.id}, '${escapeHtml(s.student_id)}', '${escapeHtml(s.name)}')">Delete</button>
        </td>
      </tr>
    `
    )
    .join('');
}

// Add Student
document.getElementById('btn-open-add-student').addEventListener('click', () => {
  if (state.batches.length === 0) {
    showToast('Please create at least one Batch first (click Manage Batches)');
    openModal('modal-batches');
    return;
  }
  document.getElementById('add-student-alert').style.display = 'none';
  document.getElementById('form-add-student').reset();
  document.getElementById('add-student-pass').value = 'Pass@123';
  openModal('modal-add-student');
});

document.getElementById('form-add-student').addEventListener('submit', async (e) => {
  e.preventDefault();
  const alertEl = document.getElementById('add-student-alert');
  alertEl.style.display = 'none';

  const student_id = document.getElementById('add-student-id').value;
  const name = document.getElementById('add-student-name').value;
  const batch_id = document.getElementById('add-student-batch').value;
  const password = document.getElementById('add-student-pass').value;

  try {
    const res = await fetch('/api/teacher/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id, name, batch_id, password }),
    });
    const data = await res.json();
    if (!data.ok) {
      alertEl.textContent = data.error;
      alertEl.style.display = 'block';
      return;
    }
    closeModal('modal-add-student');
    showToast(`Student ${student_id} added successfully`);
    loadBatches();
    loadStudents();
  } catch (err) {
    alertEl.textContent = 'Server error adding student';
    alertEl.style.display = 'block';
  }
});

// Reset Password Modal
window.openResetPasswordModal = function (id, studentId, name) {
  document.getElementById('reset-student-id').value = id;
  document.getElementById('reset-student-desc').textContent = `Set temporary password for ${studentId} (${name}):`;
  document.getElementById('reset-new-password').value = 'Pass@123';
  openModal('modal-reset-password');
};

document.getElementById('form-reset-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('reset-student-id').value;
  const new_password = document.getElementById('reset-new-password').value;

  try {
    const res = await fetch(`/api/teacher/students/${id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password }),
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error);
      return;
    }
    closeModal('modal-reset-password');
    showToast('Password reset. Student will be prompted to change it on next login.');
    loadStudents();
  } catch (err) {
    showToast('Failed to reset password');
  }
});

// Delete Student
window.deleteStudent = async function (id, studentId, name) {
  const confirmed = confirm(
    `Are you sure you want to delete student ${studentId} (${name})?\n\nThis will permanently remove the student and all their attendance records.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/teacher/students/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error);
      return;
    }
    showToast(data.message);
    loadBatches();
    loadStudents();
  } catch (err) {
    showToast('Error deleting student');
  }
};

// ==========================================
// CSV IMPORT FLOW
// ==========================================

document.getElementById('btn-open-csv-modal').addEventListener('click', () => {
  document.getElementById('csv-alert').style.display = 'none';
  document.getElementById('csv-step-upload').style.display = 'block';
  document.getElementById('csv-step-preview').style.display = 'none';
  document.getElementById('csv-file-input').value = '';
  document.getElementById('btn-preview-csv').disabled = true;
  openModal('modal-csv-import');
});

document.getElementById('csv-file-input').addEventListener('change', (e) => {
  document.getElementById('btn-preview-csv').disabled = !e.target.files.length;
});

document.getElementById('btn-preview-csv').addEventListener('click', async () => {
  const fileInput = document.getElementById('csv-file-input');
  if (!fileInput.files.length) return;

  const alertEl = document.getElementById('csv-alert');
  alertEl.style.display = 'none';

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);

  try {
    const res = await fetch('/api/teacher/students/csv-preview', {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!data.ok) {
      alertEl.textContent = data.error;
      alertEl.style.display = 'block';
      return;
    }

    state.csvValidRows = data.validRows;

    // Render Preview
    document.getElementById('csv-step-upload').style.display = 'none';
    document.getElementById('csv-step-preview').style.display = 'block';

    const summaryEl = document.getElementById('csv-summary');
    summaryEl.textContent = `Found ${data.totalRows} row(s): ${data.validCount} valid and ready to import, ${data.invalidCount} invalid.`;

    const invalidSection = document.getElementById('csv-invalid-section');
    const invalidTbody = document.getElementById('csv-invalid-table-body');
    if (data.invalidCount > 0) {
      invalidSection.style.display = 'block';
      invalidTbody.innerHTML = data.invalidRows
        .map((r) => `<tr><td>${r.rowNum}</td><td>${escapeHtml(r.studentId || '-')}</td><td>${escapeHtml(r.error)}</td></tr>`)
        .join('');
    } else {
      invalidSection.style.display = 'none';
    }

    const validTbody = document.getElementById('csv-valid-table-body');
    if (data.validCount > 0) {
      validTbody.innerHTML = data.validRows
        .map((r) => `<tr><td>${r.rowNum}</td><td>${escapeHtml(r.student_id)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.batch)}</td></tr>`)
        .join('');
      document.getElementById('btn-commit-csv-import').disabled = false;
    } else {
      validTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--muted);">No valid student records found in file.</td></tr>';
      document.getElementById('btn-commit-csv-import').disabled = true;
    }
  } catch (err) {
    alertEl.textContent = 'Failed to parse CSV file on server';
    alertEl.style.display = 'block';
  }
});

document.getElementById('btn-csv-back').addEventListener('click', () => {
  document.getElementById('csv-step-upload').style.display = 'block';
  document.getElementById('csv-step-preview').style.display = 'none';
});

document.getElementById('btn-commit-csv-import').addEventListener('click', async () => {
  if (!state.csvValidRows.length) return;

  const btn = document.getElementById('btn-commit-csv-import');
  btn.disabled = true;

  try {
    const res = await fetch('/api/teacher/students/csv-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ students: state.csvValidRows }),
    });
    const data = await res.json();
    btn.disabled = false;

    if (!data.ok) {
      showToast(data.error);
      return;
    }

    closeModal('modal-csv-import');
    showToast(data.message);
    loadBatches();
    loadStudents();
  } catch (err) {
    btn.disabled = false;
    showToast('Failed to import student records');
  }
});

window.removeAttendance = async function (attendanceId, studentId, studentName) {
  const confirmed = confirm(
    `Are you sure you want to remove check-in for ${studentId} (${studentName})?\n\nThis will be logged in session security flags.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/attendance/${attendanceId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      showToast(data.message);
      pollLiveSession();
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Failed to remove attendance record');
  }
};

// ==========================================
// SETTINGS
// ==========================================

async function loadSettings() {
  try {
    const res = await fetch('/api/teacher/settings');
    const data = await res.json();
    if (data.ok) {
      state.settings = data.settings;
      const ipSelect = document.getElementById('settings-ip');
      ipSelect.innerHTML = '';

      data.candidates.forEach((cand) => {
        const opt = document.createElement('option');
        opt.value = cand.ip;
        opt.textContent = `${cand.ip} (${cand.name})${cand.isVirtual ? ' [Virtual]' : ''}`;
        if (cand.ip === data.activeIp) {
          opt.selected = true;
        }
        ipSelect.appendChild(opt);
      });

      document.getElementById('settings-device-lock').checked = data.settings.device_lock !== 'false';
      document.getElementById('settings-grace-slots').value = data.settings.grace_window_slots || '2';
      document.getElementById('settings-loc-mode').value = data.settings.location_mode || 'flag';
      document.getElementById('settings-class-lat').value = data.settings.classroom_lat || '';
      document.getElementById('settings-class-lng').value = data.settings.classroom_lng || '';
      document.getElementById('settings-class-radius').value = data.settings.classroom_radius || '150';
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

document.getElementById('form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const preferred_ip = document.getElementById('settings-ip').value;
  const device_lock = document.getElementById('settings-device-lock').checked;
  const grace_window_slots = document.getElementById('settings-grace-slots').value;

  try {
    const res = await fetch('/api/teacher/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred_ip, device_lock, grace_window_slots }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Network & device rules saved successfully');
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Failed to save settings');
  }
});

document.getElementById('form-location-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const location_mode = document.getElementById('settings-loc-mode').value;
  const classroom_lat = document.getElementById('settings-class-lat').value;
  const classroom_lng = document.getElementById('settings-class-lng').value;
  const classroom_radius = document.getElementById('settings-class-radius').value;

  try {
    const res = await fetch('/api/teacher/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_mode, classroom_lat, classroom_lng, classroom_radius }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Classroom location settings saved successfully');
    } else {
      showToast(data.error);
    }
  } catch (err) {
    showToast('Failed to save location settings');
  }
});

document.getElementById('btn-use-current-location').addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported by your browser.');
    return;
  }

  const btn = document.getElementById('btn-use-current-location');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Acquiring GPS location...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      btn.innerHTML = originalText;
      document.getElementById('settings-class-lat').value = pos.coords.latitude.toFixed(6);
      document.getElementById('settings-class-lng').value = pos.coords.longitude.toFixed(6);
      showToast(`Classroom GPS acquired (accuracy: ±${Math.round(pos.coords.accuracy)}m)`);
    },
    (err) => {
      btn.disabled = false;
      btn.innerHTML = originalText;
      alert(`Could not get GPS location: ${err.message}. You can manually enter latitude & longitude.`);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ==========================================
// TEACHER ACCOUNTS
// ==========================================

async function loadTeacherAccounts() {
  const tbody = document.getElementById('teachers-table-body');
  if (!tbody) return;

  try {
    const res = await fetch('/api/teacher/accounts');
    const data = await res.json();
    if (!data.ok) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--error); padding: 16px;">Failed to load teacher accounts</td></tr>`;
      return;
    }

    if (!data.teachers || data.teachers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--muted); padding: 16px;">No teacher accounts found.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.teachers
      .map((t) => {
        const dateStr = t.created_at ? new Date(t.created_at).toLocaleDateString() : '-';
        return `
          <tr>
            <td><strong>${escapeHtml(t.name)}</strong></td>
            <td><code>${escapeHtml(t.username)}</code></td>
            <td class="text-sm text-muted">${dateStr}</td>
            <td style="text-align: right;">
              <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; min-height: 28px;" onclick="openResetTeacherPasswordModal(${t.id}, '${escapeHtml(t.name)}')">Reset Password</button>
              ${
                data.teachers.length > 1
                  ? `<button class="btn btn-danger" style="padding: 4px 8px; font-size: 12px; min-height: 28px; margin-left: 4px;" onclick="deleteTeacherAccount(${t.id}, '${escapeHtml(t.name)}')">Delete</button>`
                  : ''
              }
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--error); padding: 16px;">Error loading teachers</td></tr>`;
  }
}

// Add Teacher Modal & Form
const btnOpenAddTeacher = document.getElementById('btn-open-add-teacher');
if (btnOpenAddTeacher) {
  btnOpenAddTeacher.addEventListener('click', () => {
    const alertEl = document.getElementById('add-teacher-alert');
    if (alertEl) alertEl.style.display = 'none';
    const form = document.getElementById('form-add-teacher');
    if (form) form.reset();
    openModal('modal-add-teacher');
  });
}

const formAddTeacher = document.getElementById('form-add-teacher');
if (formAddTeacher) {
  formAddTeacher.addEventListener('submit', async (e) => {
    e.preventDefault();
    const alertEl = document.getElementById('add-teacher-alert');
    if (alertEl) alertEl.style.display = 'none';

    const name = document.getElementById('add-teacher-name').value;
    const username = document.getElementById('add-teacher-username').value;
    const password = document.getElementById('add-teacher-password').value;

    const btn = document.getElementById('btn-submit-add-teacher');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/teacher/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, password }),
      });
      const data = await res.json();
      if (btn) btn.disabled = false;

      if (!data.ok) {
        if (alertEl) {
          alertEl.textContent = data.error || 'Failed to create teacher account';
          alertEl.style.display = 'block';
        }
        return;
      }

      closeModal('modal-add-teacher');
      showToast(data.message || 'Teacher account created successfully');
      loadTeacherAccounts();
    } catch (err) {
      if (btn) btn.disabled = false;
      if (alertEl) {
        alertEl.textContent = 'Server connection error';
        alertEl.style.display = 'block';
      }
    }
  });
}

// Reset Teacher Password Modal & Form
window.openResetTeacherPasswordModal = function (id, name) {
  document.getElementById('reset-teacher-id').value = id;
  document.getElementById('reset-teacher-desc').textContent = `Set a new password for ${name}:`;
  const alertEl = document.getElementById('reset-teacher-alert');
  if (alertEl) alertEl.style.display = 'none';
  const form = document.getElementById('form-reset-teacher-password');
  if (form) form.reset();
  openModal('modal-reset-teacher-password');
};

const formResetTeacherPassword = document.getElementById('form-reset-teacher-password');
if (formResetTeacherPassword) {
  formResetTeacherPassword.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('reset-teacher-id').value;
    const new_password = document.getElementById('reset-teacher-new-password').value;
    const alertEl = document.getElementById('reset-teacher-alert');
    if (alertEl) alertEl.style.display = 'none';

    const btn = document.getElementById('btn-submit-reset-teacher-password');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch(`/api/teacher/accounts/${id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password }),
      });
      const data = await res.json();
      if (btn) btn.disabled = false;

      if (!data.ok) {
        if (alertEl) {
          alertEl.textContent = data.error || 'Failed to reset password';
          alertEl.style.display = 'block';
        }
        return;
      }

      closeModal('modal-reset-teacher-password');
      showToast(data.message || 'Password reset successfully');
    } catch (err) {
      if (btn) btn.disabled = false;
      if (alertEl) {
        alertEl.textContent = 'Server connection error';
        alertEl.style.display = 'block';
      }
    }
  });
}

// Delete Teacher Account
window.deleteTeacherAccount = async function (id, name) {
  if (!confirm(`Are you sure you want to delete teacher account "${name}"?`)) return;

  try {
    const res = await fetch(`/api/teacher/accounts/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error);
      return;
    }
    showToast(data.message || `Teacher "${name}" deleted`);
    loadTeacherAccounts();
  } catch (err) {
    showToast('Failed to delete teacher account');
  }
};

// Utilities
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(fn, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Start app
init();
