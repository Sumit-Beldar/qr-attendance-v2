'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 32 chars, excludes 0, O, 1, I, L
const SLOT_DURATION_MS = 7000;

/**
 * Generate a cryptographically strong session secret (32 bytes hex)
 */
function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Calculate slot number for a given timestamp since started_at
 */
function getSlotNumber(startedAtMs, currentMs = Date.now()) {
  const elapsed = Math.max(0, currentMs - startedAtMs);
  return Math.floor(elapsed / SLOT_DURATION_MS);
}

/**
 * Compute the remaining milliseconds in the current slot
 */
function getMsRemaining(startedAtMs, currentMs = Date.now()) {
  const elapsed = Math.max(0, currentMs - startedAtMs);
  return SLOT_DURATION_MS - (elapsed % SLOT_DURATION_MS);
}

/**
 * Pure HMAC-SHA256 calculation to generate 6-character alphanumeric code for a slot
 */
function getCodeForSlot(sessionSecret, slotNumber) {
  const hmac = crypto
    .createHmac('sha256', Buffer.from(sessionSecret, 'hex'))
    .update(String(slotNumber))
    .digest();

  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[hmac[i] % ALPHABET.length];
  }
  return code;
}

/**
 * Get current code and timing for an active session
 */
function getCurrentSessionCode(sessionSecret, startedAtMs, currentMs = Date.now()) {
  const slot = getSlotNumber(startedAtMs, currentMs);
  const code = getCodeForSlot(sessionSecret, slot);
  const msRemaining = getMsRemaining(startedAtMs, currentMs);
  return { code, slot, msRemaining };
}

/**
 * Generate SVG string for QR Code
 */
async function generateQrSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#1F2328',
      light: '#FFFFFF',
    },
  });
}

/**
 * Validate a student-provided code against a session
 * Allows `graceSlots` (default 2: current slot S and S-1, approx 14s)
 */
function isCodeValidForSession(inputCode, sessionSecret, startedAtMs, currentMs = Date.now(), graceSlots = 3) {
  if (!inputCode || typeof inputCode !== 'string') return false;
  const cleanCode = inputCode.trim().toUpperCase();
  if (cleanCode.length !== 6) return false;

  const currentSlot = getSlotNumber(startedAtMs, currentMs);
  const slotsCount = Math.max(1, parseInt(graceSlots, 10) || 3);
  const slotsToCheck = [];

  for (let i = 0; i < slotsCount; i++) {
    const s = currentSlot - i;
    if (s >= 0) slotsToCheck.push(s);
  }

  for (const slot of slotsToCheck) {
    const validCode = getCodeForSlot(sessionSecret, slot);
    if (cleanCode === validCode) {
      return true;
    }
  }

  return false;
}

/**
 * Generate a short-lived signed check-in ticket (valid for 60s)
 * Allows separating immediate 7-second code validation from multi-second geolocation lookup
 */
function generateCheckinTicket(sessionId, studentDbId, secret, ttlMs = 60000) {
  const now = Date.now();
  const payload = {
    sid: sessionId,
    uid: studentDbId,
    iat: now,
    exp: now + ttlMs,
    nonce: crypto.randomBytes(8).toString('hex'),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${signature}`;
}

/**
 * Verify a signed check-in ticket
 * Returns payload { sid, uid, exp, iat } if valid and unexpired, else null
 */
function verifyCheckinTicket(ticket, secret) {
  if (!ticket || typeof ticket !== 'string' || !ticket.includes('.')) return null;

  const [payloadB64, signature] = ticket.split('.');
  if (!payloadB64 || !signature) return null;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp) {
      return null; // Expired
    }
    return payload;
  } catch (err) {
    return null;
  }
}

module.exports = {
  ALPHABET,
  SLOT_DURATION_MS,
  generateSessionSecret,
  getSlotNumber,
  getMsRemaining,
  getCodeForSlot,
  getCurrentSessionCode,
  generateQrSvg,
  isCodeValidForSession,
  generateCheckinTicket,
  verifyCheckinTicket,
};
