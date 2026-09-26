const assert = require('assert');
const {
  generateSessionSecret,
  getSlotNumber,
  getMsRemaining,
  getCodeForSlot,
  getCurrentSessionCode,
  isCodeValidForSession,
  generateQrSvg,
} = require('../src/codes');

async function runTests() {
  console.log('Running test-codes suite...');

  const secret = generateSessionSecret();
  assert.strictEqual(secret.length, 64, 'Session secret should be 32 bytes hex (64 chars)');

  const startedAt = 1000000;
  // Slot 0 at startedAt
  assert.strictEqual(getSlotNumber(startedAt, 1000000), 0);
  assert.strictEqual(getSlotNumber(startedAt, 1006999), 0);
  // Slot 1 at +7000ms
  assert.strictEqual(getSlotNumber(startedAt, 1007000), 1);
  assert.strictEqual(getSlotNumber(startedAt, 1013999), 1);
  // Slot 2 at +14000ms
  assert.strictEqual(getSlotNumber(startedAt, 1014000), 2);

  // Remaining time in slot
  assert.strictEqual(getMsRemaining(startedAt, 1000000), 7000);
  assert.strictEqual(getMsRemaining(startedAt, 1002000), 5000);
  assert.strictEqual(getMsRemaining(startedAt, 1006999), 1);

  // Code format and alphabet check
  const code0 = getCodeForSlot(secret, 0);
  const code1 = getCodeForSlot(secret, 1);
  const code2 = getCodeForSlot(secret, 2);

  assert.strictEqual(code0.length, 6, 'Code must be exactly 6 chars');
  assert.strictEqual(typeof code0, 'string');
  assert(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code0), 'Code must use only allowed 32 chars');
  assert.notStrictEqual(code0, code1, 'Consecutive slot codes should differ');

  // Validity checks (Grace period: Slot S, S-1, S-2)
  // At slot 0:
  assert.strictEqual(isCodeValidForSession(code0, secret, startedAt, 1001000), true);
  assert.strictEqual(isCodeValidForSession(code0.toLowerCase(), secret, startedAt, 1001000), true, 'Case insensitive');
  assert.strictEqual(isCodeValidForSession(`  ${code0}  `, secret, startedAt, 1001000), true, 'Trim whitespace');
  assert.strictEqual(isCodeValidForSession('INVALID', secret, startedAt, 1001000), false);

  // At slot 2 (+14500ms):
  // Should accept code2 (current), code1 (previous), and code0 (2 slots ago)
  const nowSlot2 = 1014500;
  assert.strictEqual(isCodeValidForSession(code2, secret, startedAt, nowSlot2), true, 'Current slot is valid');
  assert.strictEqual(isCodeValidForSession(code1, secret, startedAt, nowSlot2), true, 'Slot -1 is valid');
  assert.strictEqual(isCodeValidForSession(code0, secret, startedAt, nowSlot2), true, 'Slot -2 is valid');

  // At slot 3 (+21500ms):
  // code0 is 3 slots ago -> should expire!
  const nowSlot3 = 1021500;
  const code3 = getCodeForSlot(secret, 3);
  assert.strictEqual(isCodeValidForSession(code3, secret, startedAt, nowSlot3), true, 'Current slot is valid');
  assert.strictEqual(isCodeValidForSession(code0, secret, startedAt, nowSlot3), false, 'Slot -3 should be expired');

  // SVG QR Generation
  const svg = await generateQrSvg('https://192.168.1.5:3443/a/' + code0);
  assert(svg.startsWith('<svg'), 'QR should be valid SVG string');
  assert(svg.includes('</svg>'), 'QR SVG should be closed tag');

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
