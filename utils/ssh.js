// SSH helpers: connect with host-key pinning, and run a command with input on stdin.
const crypto = require('node:crypto');
const { Client } = require('ssh2');
const { env } = require('./env');

class SshError extends Error {
  /** reason: HOST_KEY_CHANGED | AUTH_FAILED | TIMEOUT | UNREACHABLE | FAILED */
  constructor(reason, message, details) {
    super(message);
    this.name = 'SshError';
    this.reason = reason;
    this.details = details;
  }
}

/** Same format as `ssh-keygen -lf`: SHA256:<base64 without padding>. */
const fingerprintOf = (hostKey) =>
  `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;

function toSshError(err, target) {
  if (err instanceof SshError) return err;
  if (err.level === 'client-authentication') {
    return new SshError('AUTH_FAILED', 'The server refused the login: check the username and the key or password');
  }
  if (err.level === 'client-timeout' || /timed out/i.test(err.message)) {
    return new SshError('TIMEOUT', `Timed out connecting to ${target}`);
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(err.code)) {
    return new SshError('UNREACHABLE', `Could not reach ${target} (${err.code})`);
  }
  return new SshError('FAILED', `SSH connection to ${target} failed: ${err.message}`);
}

/**
 * Opens an SSH connection. When expectedFingerprint is set, a server presenting any other host
 * key is refused with reason HOST_KEY_CHANGED. Resolves to { conn, fingerprint }.
 */
function connect({
  host,
  port,
  username,
  authType,
  secret,
  passphrase,
  expectedFingerprint,
  readyTimeout = env.SSH_READY_TIMEOUT_MS,
}) {
  const target = `${host}:${port}`;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let fingerprint;
    let keyChanged = false;

    conn
      .on('ready', () => resolve({ conn, fingerprint }))
      .on('error', (err) => {
        conn.end();
        reject(
          keyChanged
            ? new SshError('HOST_KEY_CHANGED', `The host key of ${target} has changed`, {
                expected: expectedFingerprint,
                received: fingerprint,
              })
            : toSshError(err, target),
        );
      })
      // Some servers ask for the password through keyboard-interactive.
      .on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) =>
        finish(prompts.map(() => secret)),
      );

    try {
      conn.connect({
        host,
        port,
        username,
        readyTimeout,
        ...(authType === 'PASSWORD'
          ? { password: secret, tryKeyboard: true }
          : { privateKey: secret, passphrase: passphrase ?? undefined }),
        hostVerifier: (hostKey) => {
          fingerprint = fingerprintOf(hostKey);
          keyChanged = Boolean(expectedFingerprint) && fingerprint !== expectedFingerprint;
          return !keyChanged;
        },
      });
    } catch (err) {
      conn.end();
      reject(toSshError(err, target));
    }
  });
}

/**
 * Runs one command, writing `stdin` to it, and resolves to { code, stdout, stderr }.
 * The channel is closed if it runs longer than timeoutMs.
 */
function exec(conn, command, { stdin = '', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(toSshError(err, 'the server'));
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new SshError('TIMEOUT', `Command did not finish within ${timeoutMs / 1000} s`));
      }, timeoutMs);

      stream
        .on('data', (chunk) => (stdout += chunk))
        .on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      stream.stderr.on('data', (chunk) => (stderr += chunk));
      stream.end(stdin);
    });
  });
}

/**
 * Starts a command, writes `stdin` to it, and resolves to the open channel so the caller can
 * stream its output ('data', stderr 'data', 'exit', 'close').
 */
function spawn(conn, command, stdin = '') {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(toSshError(err, 'the server'));
      stream.end(stdin);
      resolve(stream);
    });
  });
}

module.exports = { SshError, fingerprintOf, connect, exec, spawn };
