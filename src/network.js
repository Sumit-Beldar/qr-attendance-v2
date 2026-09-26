const os = require('os');
const { queryOne } = require('./db');

/**
 * Filter and prioritize candidate LAN IPv4 addresses
 */
function getLanIpCandidates() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  const ignoredKeywords = [
    'loopback',
    'virtual',
    'vbox',
    'vmware',
    'wsl',
    'docker',
    'hyper-v',
    'vethernet',
    'tap',
    'tun',
    'tailscale',
    'zerotier',
  ];

  for (const [name, addrs] of Object.entries(interfaces)) {
    const lowerName = name.toLowerCase();
    const isVirtual = ignoredKeywords.some((k) => lowerName.includes(k));

    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const ip = addr.address;
        let priority = 4;
        if (ip.startsWith('192.168.')) {
          priority = 1;
        } else if (ip.startsWith('10.')) {
          priority = 2;
        } else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) {
          priority = 3;
        }

        candidates.push({
          name,
          ip,
          isVirtual,
          priority: isVirtual ? priority + 10 : priority,
        });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates;
}

// In-memory cache for preferred_ip to avoid blocking synchronous calls when needed
let cachedPreferredIp = '';

async function refreshPreferredIp() {
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key = 'preferred_ip'");
    if (row && row.value) {
      cachedPreferredIp = row.value.trim();
    }
  } catch (err) {
    // DB might not be ready yet
  }
}

/**
 * Get active LAN IP: checks cached/queried 'preferred_ip' setting or picks best candidate
 */
function getActiveLanIp() {
  if (cachedPreferredIp && cachedPreferredIp.length > 0) {
    return cachedPreferredIp;
  }

  const candidates = getLanIpCandidates();
  if (candidates.length > 0) {
    return candidates[0].ip;
  }
  return '127.0.0.1';
}

async function getActiveLanIpAsync() {
  await refreshPreferredIp();
  return getActiveLanIp();
}

module.exports = {
  getLanIpCandidates,
  getActiveLanIp,
  getActiveLanIpAsync,
  refreshPreferredIp,
};
