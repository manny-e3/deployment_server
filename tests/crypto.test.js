require('./setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decrypt, encrypt, normalizePrivateKey, generateSshKeyPair } = require('../utils/crypto');
const { parseKey } = require('ssh2/lib/protocol/keyParser.js');

describe('utils/crypto', () => {
  it('round-trips text, including multi-line keys and non-ASCII', () => {
    for (const text of ['hunter2', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n', 'pässwörd ✓', '']) {
      assert.equal(decrypt(encrypt(text)), text);
    }
  });

  it('stores values as v1:<iv>:<tag>:<ciphertext> with a fresh IV each time', () => {
    const a = encrypt('same input');
    const b = encrypt('same input');
    assert.match(a, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/);
    assert.notEqual(a, b);
    assert.ok(!a.includes('same input'));
  });

  it('detects a changed ciphertext', () => {
    const [version, iv, tag, ciphertext] = encrypt('secret value').split(':');
    const bytes = Buffer.from(ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered = [version, iv, tag, bytes.toString('base64')].join(':');
    assert.throws(() => decrypt(tampered), /could not be decrypted/);
  });

  it('refuses a value encrypted with another key', () => {
    const otherKey = crypto.randomBytes(32);
    assert.throws(() => decrypt(encrypt('secret value', otherKey)), /could not be decrypted/);
  });

  it('refuses values not in the v1 format', () => {
    for (const bad of ['plain text', 'v2:a:b:c', 'v1:only-two']) {
      assert.throws(() => decrypt(bad), /v1 format/);
    }
  });

  it('generateSshKeyPair produces OpenSSH format compatible with ssh2', () => {
    const kp = generateSshKeyPair('test-comment');
    assert.match(kp.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ test-comment$/);
    assert.match(kp.privateKey, /-----BEGIN OPENSSH PRIVATE KEY-----/);
    const parsed = parseKey(kp.privateKey);
    assert.ok(!(parsed instanceof Error), `Key failed to parse: ${parsed?.message}`);
  });

  it('normalizePrivateKey converts PKCS#8 Ed25519 to ssh2-compatible OpenSSH format', () => {
    const rawEd = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // ssh2 throws on raw PKCS#8
    const rawParsed = parseKey(rawEd.privateKey);
    assert.ok(rawParsed instanceof Error);

    // normalized parses cleanly in ssh2
    const normalized = normalizePrivateKey(rawEd.privateKey);
    assert.match(normalized, /-----BEGIN OPENSSH PRIVATE KEY-----/);
    const parsed = parseKey(normalized);
    assert.ok(!(parsed instanceof Error), `Normalized key failed to parse: ${parsed?.message}`);
  });
});
