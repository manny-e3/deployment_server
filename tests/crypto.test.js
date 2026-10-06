require('./setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decrypt, encrypt } = require('../utils/crypto');

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
});
