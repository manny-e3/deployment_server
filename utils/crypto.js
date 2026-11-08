// Encrypts secrets (SSH keys, passwords, env values) before they are stored.
// AES-256-GCM with a random 12-byte IV per value, stored as  v1:<iv>:<tag>:<ciphertext>  (base64).
// The v1 prefix leaves room to rotate to a new key later.
const crypto = require('node:crypto');
const { env } = require('./env');

const VERSION = 'v1';
const defaultKey = Buffer.from(env.ENCRYPTION_KEY, 'hex');

function encrypt(plaintext, key = defaultKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext].map((p) => (Buffer.isBuffer(p) ? p.toString('base64') : p)).join(':');
}

/** Throws if the value is malformed, was changed, or was encrypted with another key. */
function decrypt(stored, key = defaultKey) {
  const [version, iv, tag, ciphertext] = String(stored).split(':');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Stored secret is not in the v1 format');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new Error('Stored secret could not be decrypted (wrong ENCRYPTION_KEY or changed data)');
  }
}

/**
 * Generates an Ed25519 keypair for zero-friction SSH onboarding.
 * Returns:
 *   - privateKey: PEM string (PKCS#8) to encrypt and store in secretEnc
 *   - publicKey: OpenSSH format string `ssh-ed25519 AAAAC3... portalops-deployer`
 */
function generateSshKeyPair(comment = 'portalops-deployer') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = der.subarray(12);
  const typeStr = Buffer.from('ssh-ed25519');
  const wire = Buffer.concat([
    Buffer.from([0, 0, 0, typeStr.length]),
    typeStr,
    Buffer.from([0, 0, 0, rawPub.length]),
    rawPub,
  ]);
  const openSshPublicKey = `ssh-ed25519 ${wire.toString('base64')} ${comment}`;

  return {
    privateKey,
    publicKey: openSshPublicKey,
  };
}

module.exports = { encrypt, decrypt, generateSshKeyPair };
