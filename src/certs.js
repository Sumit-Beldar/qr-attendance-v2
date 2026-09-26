const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const { getLanIpCandidates } = require('./network');

const CERTS_DIR = path.join(__dirname, '..', 'certs');
const KEY_PATH = path.join(CERTS_DIR, 'server.key');
const CERT_PATH = path.join(CERTS_DIR, 'server.crt');

/**
 * Ensure SSL/TLS certificate exists, generating a self-signed one with all LAN IPs as SANs if needed.
 */
async function getOrCreateCertificate() {
  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }

  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return {
      key: fs.readFileSync(KEY_PATH, 'utf8'),
      cert: fs.readFileSync(CERT_PATH, 'utf8'),
    };
  }

  const attrs = [{ name: 'commonName', value: 'Attendance System' }];
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];

  const candidates = getLanIpCandidates();
  for (const cand of candidates) {
    altNames.push({ type: 7, ip: cand.ip });
  }

  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.writeFileSync(KEY_PATH, pems.private, 'utf8');
  fs.writeFileSync(CERT_PATH, pems.cert, 'utf8');

  return {
    key: pems.private,
    cert: pems.cert,
  };
}

module.exports = {
  getOrCreateCertificate,
};
