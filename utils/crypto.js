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
 * Normalizes private keys to formats supported by ssh2:
 * - Ed25519 PKCS#8 (-----BEGIN PRIVATE KEY-----) -> OpenSSH format (-----BEGIN OPENSSH PRIVATE KEY-----)
 * - RSA PKCS#8 -> PKCS#1 (-----BEGIN RSA PRIVATE KEY-----)
 * - EC PKCS#8 -> SEC1 (-----BEGIN EC PRIVATE KEY-----)
 * Keys already in OpenSSH, PKCS#1, SEC1 or PPK format are preserved.
 */
function normalizePrivateKey(key) {
  if (!key) return key;
  if (Buffer.isBuffer(key)) key = key.toString('utf8');
  if (typeof key !== 'string') return key;

  const trimmed = key.trim();
  if (!trimmed.includes('-----BEGIN PRIVATE KEY-----')) {
    return trimmed;
  }

  try {
    const keyObj = crypto.createPrivateKey(trimmed);
    if (keyObj.asymmetricKeyType === 'ed25519') {
      const pubObj = crypto.createPublicKey(keyObj);
      const pubDer = pubObj.export({ type: 'spki', format: 'der' });
      const privDer = keyObj.export({ type: 'pkcs8', format: 'der' });

      // Ed25519 SPKI DER has 12 bytes header, followed by 32 bytes public key
      const rawPub = pubDer.subarray(12);
      // Ed25519 PKCS#8 DER has 16 bytes header, followed by 32 bytes private seed
      const rawPriv = privDer.subarray(16);

      if (rawPub.length === 32 && rawPriv.length === 32) {
        const keyName = Buffer.from('ssh-ed25519');
        const checkint = crypto.randomBytes(4);

        const privSection = Buffer.concat([
          checkint,
          checkint,
          Buffer.from([0, 0, 0, keyName.length]),
          keyName,
          Buffer.from([0, 0, 0, rawPub.length]),
          rawPub,
          Buffer.from([0, 0, 0, 64]), // 64 bytes: private key + public key
          rawPriv,
          rawPub,
          Buffer.from([0, 0, 0, 0]), // comment
        ]);

        const padLen = (8 - (privSection.length % 8)) % 8;
        const pad = Buffer.alloc(padLen);
        for (let i = 0; i < padLen; i++) pad[i] = i + 1;
        const paddedPriv = Buffer.concat([privSection, pad]);

        const pubSection = Buffer.concat([
          Buffer.from([0, 0, 0, keyName.length]),
          keyName,
          Buffer.from([0, 0, 0, rawPub.length]),
          rawPub,
        ]);

        const openSshBuf = Buffer.concat([
          Buffer.from('openssh-key-v1\0'),
          Buffer.from([0, 0, 0, 4]), Buffer.from('none'), // cipher
          Buffer.from([0, 0, 0, 4]), Buffer.from('none'), // kdf
          Buffer.from([0, 0, 0, 0]), // kdf opts
          Buffer.from([0, 0, 0, 1]), // num keys
          Buffer.from([0, 0, 0, pubSection.length]), pubSection,
          Buffer.from([0, 0, 0, paddedPriv.length]), paddedPriv,
        ]);

        const b64 = openSshBuf.toString('base64').match(/.{1,70}/g).join('\n');
        return '-----BEGIN OPENSSH PRIVATE KEY-----\n' + b64 + '\n-----END OPENSSH PRIVATE KEY-----\n';
      }
    } else if (keyObj.asymmetricKeyType === 'rsa') {
      return keyObj.export({ type: 'pkcs1', format: 'pem' });
    } else if (keyObj.asymmetricKeyType === 'ec') {
      return keyObj.export({ type: 'sec1', format: 'pem' });
    }
  } catch {
    // If parse fails, return trimmed key as fallback
  }

  return trimmed;
}

/**
 * Generates an Ed25519 keypair for zero-friction SSH onboarding.
 * Returns:
 *   - privateKey: OpenSSH formatted private key string to encrypt and store in secretEnc
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
    privateKey: normalizePrivateKey(privateKey),
    publicKey: openSshPublicKey,
  };
}

module.exports = { encrypt, decrypt, normalizePrivateKey, generateSshKeyPair };
