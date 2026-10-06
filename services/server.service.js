const serverModel = require('../models/server.model');
const audit = require('./audit.service');
const { decrypt, encrypt } = require('../utils/crypto');
const { BusinessRuleError, Conflict, NotFound, ValidationError } = require('../utils/errors');
const ssh = require('../utils/ssh');

// Fields that may appear in audit details. Secrets never do.
const AUDITED_FIELDS = ['name', 'host', 'port', 'username', 'authType'];

const list = (query) => serverModel.list(query);

async function get(id) {
  const server = await serverModel.findById(id);
  if (!server) throw new NotFound('Server');
  return server;
}

async function create(body, actor, ip) {
  const { secret, passphrase, ...fields } = body;
  const server = await serverModel.create({
    ...fields,
    secretEnc: encrypt(secret),
    passphraseEnc: passphrase ? encrypt(passphrase) : null,
  });

  await audit.record({
    userId: actor.id,
    action: 'server.created',
    entity: 'server',
    entityId: server.id,
    details: Object.fromEntries(AUDITED_FIELDS.map((f) => [f, server[f]])),
    ip,
  });
  return server;
}

/**
 * Updates a server. A new secret replaces the old one; passphrase null removes it.
 * Moving to a different host or port forgets the pinned host key, since it is another machine.
 */
async function update(id, body, actor, ip) {
  const before = await get(id);
  const { secret, passphrase, ...fields } = body;
  const keyAuth = (fields.authType ?? before.authType) === 'KEY';
  if (secret !== undefined && keyAuth && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret)) {
    throw new ValidationError([
      { field: 'body.secret', message: 'must be a private key in PEM or OpenSSH format' },
    ]);
  }

  const data = { ...fields };
  if (secret !== undefined) data.secretEnc = encrypt(secret);
  if (passphrase !== undefined) data.passphraseEnc = passphrase ? encrypt(passphrase) : null;
  const movesHost =
    (fields.host !== undefined && fields.host !== before.host) ||
    (fields.port !== undefined && fields.port !== before.port);
  if (movesHost) data.hostFingerprint = null;

  const server = await serverModel.update(id, data);

  const diff = Object.fromEntries(
    AUDITED_FIELDS.filter((f) => fields[f] !== undefined && fields[f] !== before[f]).map((f) => [
      f,
      { from: before[f], to: fields[f] },
    ]),
  );
  if (secret !== undefined) diff.secretChanged = true;
  if (passphrase !== undefined) diff.passphraseChanged = true;
  await audit.record({
    userId: actor.id,
    action: 'server.updated',
    entity: 'server',
    entityId: id,
    details: diff,
    ip,
  });
  return server;
}

async function remove(id, actor, ip) {
  const server = await get(id);
  const targetCount = await serverModel.countTargets(id);
  if (targetCount > 0) {
    throw new Conflict(
      'SERVER_IN_USE',
      `${server.name} is used by ${targetCount} target(s); move or delete them first`,
      { targetCount },
    );
  }
  await serverModel.remove(id);
  await audit.record({
    userId: actor.id,
    action: 'server.deleted',
    entity: 'server',
    entityId: id,
    details: { name: server.name, host: server.host },
    ip,
  });
}

const TEST_SCRIPT = [
  'echo "whoami=$(whoami)"',
  'echo "git=$(git --version 2>/dev/null || echo missing)"',
  'echo "disk_kb=$(df -Pk "$HOME" | awk \'NR==2 {print $4}\')"',
].join('\n');

const parseLines = (stdout) =>
  Object.fromEntries(
    stdout
      .split('\n')
      .map((line) => line.trim().split(/=(.*)/s))
      .filter(([key]) => key),
  );

/**
 * Connects to the server and reports who we log in as, the git version and free disk space.
 * The first successful connection pins the host key; after that a different key is refused.
 */
async function testConnection(id, actor, ip) {
  const server = await serverModel.findByIdWithSecrets(id);
  if (!server) throw new NotFound('Server');

  let conn;
  let fingerprint;
  try {
    ({ conn, fingerprint } = await ssh.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      authType: server.authType,
      secret: decrypt(server.secretEnc),
      passphrase: server.passphraseEnc ? decrypt(server.passphraseEnc) : undefined,
      expectedFingerprint: server.hostFingerprint,
    }));
    const { stdout } = await ssh.exec(conn, 'sh -s', { stdin: TEST_SCRIPT, timeoutMs: 15_000 });
    const info = parseLines(stdout);

    const pinned = !server.hostFingerprint;
    await serverModel.update(id, {
      lastCheckAt: new Date(),
      lastCheckOk: true,
      ...(pinned && { hostFingerprint: fingerprint }),
    });
    await audit.record({
      userId: actor.id,
      action: 'server.tested',
      entity: 'server',
      entityId: id,
      details: { ok: true, fingerprintPinned: pinned },
      ip,
    });

    return {
      ok: true,
      whoami: info.whoami,
      gitVersion: info.git === 'missing' ? null : info.git,
      freeDiskMb: info.disk_kb ? Math.round(Number(info.disk_kb) / 1024) : null,
      fingerprint,
      fingerprintPinned: pinned,
    };
  } catch (err) {
    await serverModel.update(id, { lastCheckAt: new Date(), lastCheckOk: false });
    if (!(err instanceof ssh.SshError)) throw err;

    await audit.record({
      userId: actor.id,
      action: 'server.tested',
      entity: 'server',
      entityId: id,
      details: { ok: false, reason: err.reason },
      ip,
    });
    if (err.reason === 'HOST_KEY_CHANGED') {
      throw new Conflict(
        'HOST_KEY_CHANGED',
        'The server presented a different host key than the one pinned. If the server was ' +
          'rebuilt on purpose, reset the fingerprint; otherwise do not trust this connection.',
        err.details,
      );
    }
    throw new BusinessRuleError(`SSH_${err.reason}`, err.message);
  } finally {
    conn?.end();
  }
}

/** Forgets the pinned host key; the next successful test pins the new one. */
async function resetFingerprint(id, actor, ip) {
  const before = await get(id);
  const server = await serverModel.update(id, { hostFingerprint: null });
  await audit.record({
    userId: actor.id,
    action: 'server.fingerprint_reset',
    entity: 'server',
    entityId: id,
    details: { previous: before.hostFingerprint },
    ip,
  });
  return server;
}

module.exports = { list, get, create, update, remove, testConnection, resetFingerprint };
