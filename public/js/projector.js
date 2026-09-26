// Projector View Script

let sessionId = null;
let currentCode = '';
let pollTimer = null;
let animFrameId = null;
let slotTargetMs = 0;
let slotStartedLocalMs = 0;
let slotDurationMs = 7000;
let isReconnecting = false;

// Extract Session ID from pathname /projector/123 or search params ?id=123
function getSessionId() {
  const parts = window.location.pathname.split('/');
  const lastPart = parts[parts.length - 1];
  if (lastPart && !isNaN(parseInt(lastPart, 10))) {
    return parseInt(lastPart, 10);
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get('id')) {
    return parseInt(params.get('id'), 10);
  }
  return null;
}

async function fetchSessionCurrent() {
  if (!sessionId) return;

  try {
    const res = await fetch(`/api/sessions/${sessionId}/current`);
    if (!res.ok) {
      if (res.status === 404) {
        showEndedScreen('Session not found', 0, 0);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (isReconnecting) {
      isReconnecting = false;
      document.getElementById('reconnect-banner').style.display = 'none';
    }

    if (!data.active) {
      showEndedScreen(data.title, data.presentCount, data.totalStudents);
      return;
    }

    updateDisplay(data);
  } catch (err) {
    console.warn('Projector poll failed, will retry:', err);
    if (!isReconnecting) {
      isReconnecting = true;
      document.getElementById('reconnect-banner').style.display = 'block';
    }
  }
}

function updateDisplay(data) {
  document.getElementById('disp-title').textContent = data.title;
  document.getElementById('disp-batch').textContent = data.batchName;
  document.getElementById('disp-present').textContent = data.presentCount;
  document.getElementById('disp-total').textContent = data.totalStudents;

  // If code changed, swap QR smoothly
  if (data.code !== currentCode) {
    currentCode = data.code;
    document.getElementById('disp-code').textContent = data.code;
    document.getElementById('disp-url').textContent = data.shortDisplay || data.url;

    const qrContainer = document.getElementById('qr-container');
    // Direct SVG insertion with no flicker
    qrContainer.innerHTML = data.qrSvg;
  }

  // Smooth Countdown Synchronization using server's msRemaining
  slotDurationMs = 7000;
  slotTargetMs = data.msRemaining;
  slotStartedLocalMs = performance.now();
  startProgressBar();
}

function startProgressBar() {
  if (animFrameId) cancelAnimationFrame(animFrameId);

  const progressBar = document.getElementById('code-progress');

  function render() {
    const elapsedLocal = performance.now() - slotStartedLocalMs;
    const remaining = Math.max(0, slotTargetMs - elapsedLocal);
    const fraction = remaining / slotDurationMs;
    const pct = Math.max(0, Math.min(100, fraction * 100));

    progressBar.style.width = `${pct}%`;

    if (remaining > 0) {
      animFrameId = requestAnimationFrame(render);
    }
  }

  animFrameId = requestAnimationFrame(render);
}

function showEndedScreen(title, present, total) {
  if (pollTimer) clearInterval(pollTimer);
  if (animFrameId) cancelAnimationFrame(animFrameId);

  document.getElementById('stage-active').style.display = 'none';
  document.getElementById('code-progress').parentElement.style.display = 'none';
  document.getElementById('stage-ended').style.display = 'block';

  document.getElementById('final-present').textContent = present;
  document.getElementById('final-total').textContent = total;
  document.getElementById('disp-present').textContent = present;
  document.getElementById('disp-total').textContent = total;
}

// Fullscreen API toggle
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.warn('Fullscreen request failed:', err);
    });
    document.getElementById('btn-fullscreen').textContent = 'Exit Fullscreen';
  } else {
    document.exitFullscreen().catch(() => {});
    document.getElementById('btn-fullscreen').textContent = 'Full Screen';
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    document.getElementById('btn-fullscreen').textContent = 'Full Screen';
  } else {
    document.getElementById('btn-fullscreen').textContent = 'Exit Fullscreen';
  }
});

// End Session
document.getElementById('btn-end-session').addEventListener('click', async () => {
  const confirmed = confirm('Are you sure you want to end this attendance session? Students will no longer be able to mark attendance.');
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/sessions/${sessionId}/end`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      fetchSessionCurrent();
    } else {
      alert(data.error || 'Failed to end session');
    }
  } catch (err) {
    alert('Network error ending session');
  }
});

// Initialize
sessionId = getSessionId();
if (!sessionId) {
  document.getElementById('disp-title').textContent = 'Error: Missing Session ID';
} else {
  fetchSessionCurrent();
  pollTimer = setInterval(fetchSessionCurrent, 1000);
}
