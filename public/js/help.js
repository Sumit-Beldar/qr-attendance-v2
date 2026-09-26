'use strict';

async function initHelpPage() {
  try {
    const res = await fetch('/api/teacher/setup-status');
    const data = await res.json();
    if (data.isProduction) {
      const localCertSection = document.getElementById('section-local-certs');
      const prodGuideSection = document.getElementById('section-prod-guide');
      if (localCertSection) localCertSection.style.display = 'none';
      if (prodGuideSection) prodGuideSection.style.display = 'block';
    }
  } catch (e) {
    // Keep default display
  }
}

document.addEventListener('DOMContentLoaded', initHelpPage);
