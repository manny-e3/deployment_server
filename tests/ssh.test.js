// Runs against the sshd container (docker compose up -d sshd).
const { TEST_SSH } = require('./setup');
const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ssh = require('../utils/ssh');

const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures', 'test_ed25519'), 'utf8');
const base = { host: TEST_SSH.host, port: TEST_SSH.port, username: TEST_SSH.username };
const withPassword = { ...base, authType: 'PASSWORD', secret: TEST_SSH.password };

/** The container takes a few seconds to start sshd; wait up to 60 s for it. */
async function waitForSshd() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const { conn } = await ssh.connect({ ...withPassword, readyTimeout: 5000 });
      return conn.end();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

describe('utils/ssh against the sshd container', () => {
  before(waitForSshd);

  it('logs in with a password and returns the host key fingerprint', async () => {
    const { conn, fingerprint } = await ssh.connect(withPassword);
    conn.end();
    assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('logs in with a private key and runs a command with stdin', async () => {
    const { conn } = await ssh.connect({ ...base, authType: 'KEY', secret: privateKey });
    try {
      const result = await ssh.exec(conn, 'sh -s', { stdin: 'whoami\necho "$((6 * 7))"\nexit 3\n' });
      assert.equal(result.code, 3);
      assert.equal(result.stdout, 'deploy\n42\n');
    } finally {
      conn.end();
    }
  });

  it('accepts the pinned host key', async () => {
    const first = await ssh.connect(withPassword);
    first.conn.end();
    const second = await ssh.connect({ ...withPassword, expectedFingerprint: first.fingerprint });
    second.conn.end();
    assert.equal(second.fingerprint, first.fingerprint);
  });

  it('refuses a changed host key', async () => {
    const expected = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await assert.rejects(ssh.connect({ ...withPassword, expectedFingerprint: expected }), (err) => {
      assert.equal(err.reason, 'HOST_KEY_CHANGED');
      assert.equal(err.details.expected, expected);
      assert.match(err.details.received, /^SHA256:/);
      return true;
    });
  });

  it('reports a wrong password as AUTH_FAILED', async () => {
    await assert.rejects(ssh.connect({ ...withPassword, secret: 'wrong-password' }), {
      reason: 'AUTH_FAILED',
    });
  });

  it('reports a closed port as UNREACHABLE', async () => {
    await assert.rejects(ssh.connect({ ...withPassword, port: 1 }), { reason: 'UNREACHABLE' });
  });

  it('stops a command that runs past its timeout', async () => {
    const { conn } = await ssh.connect(withPassword);
    try {
      await assert.rejects(ssh.exec(conn, 'sleep 5', { timeoutMs: 500 }), { reason: 'TIMEOUT' });
    } finally {
      conn.end();
    }
  });
});
