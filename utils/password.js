const crypto = require('crypto');

let nativeArgon2 = null;
try {
  nativeArgon2 = require('argon2');
} catch (err) {
  // Native addon unavailable or GLIBC mismatch; fallback to noble/hashes pure-JS
}

let nobleArgon2 = null;
try {
  nobleArgon2 = require('@noble/hashes/argon2.js');
} catch (err) {
  try {
    nobleArgon2 = require('@noble/hashes/argon2');
  } catch (err2) {
    // Noble hashes fallback
  }
}

function parsePhc(hashString) {
  const parts = hashString.split('$').filter(Boolean);
  if (parts[0] !== 'argon2id') throw new Error('Unsupported algorithm');

  const version = parseInt(parts[1].replace('v=', ''), 10);
  const params = {};
  parts[2].split(',').forEach((kv) => {
    const [k, v] = kv.split('=');
    params[k] = parseInt(v, 10);
  });

  const saltB64 = parts[3].replace(/-/g, '+').replace(/_/g, '/');
  const hashB64 = parts[4].replace(/-/g, '+').replace(/_/g, '/');

  const salt = Buffer.from(saltB64, 'base64');
  const expectedHash = Buffer.from(hashB64, 'base64');

  return { version, params, salt, expectedHash };
}

async function verifyPureJs(hashString, password) {
  try {
    if (!nobleArgon2) throw new Error('Noble hashes argon2 unavailable');
    const { params, salt, expectedHash } = parsePhc(hashString);
    const derived = nobleArgon2.argon2id(Buffer.from(password), salt, {
      m: params.m,
      t: params.t,
      p: params.p,
      dkLen: expectedHash.length,
    });
    return crypto.timingSafeEqual(Buffer.from(derived), expectedHash);
  } catch (err) {
    return false;
  }
}

async function hashPureJs(password) {
  if (!nobleArgon2) throw new Error('Noble hashes argon2 unavailable');
  const salt = crypto.randomBytes(16);
  const m = 65536;
  const t = 3;
  const p = 4;
  const dkLen = 32;
  const derived = nobleArgon2.argon2id(Buffer.from(password), salt, { m, t, p, dkLen });

  const saltB64 = salt.toString('base64').replace(/=/g, '');
  const hashB64 = Buffer.from(derived).toString('base64').replace(/=/g, '');
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${saltB64}$${hashB64}`;
}

async function hashPassword(password) {
  if (nativeArgon2) {
    try {
      return await nativeArgon2.hash(password, { type: nativeArgon2.argon2id });
    } catch (_) { }
  }
  return hashPureJs(password);
}

async function verifyPassword(hashString, password) {
  if (nativeArgon2) {
    try {
      return await nativeArgon2.verify(hashString, password);
    } catch (_) { }
  }
  return verifyPureJs(hashString, password);
}

module.exports = {
  hashPassword,
  verifyPassword,
};

