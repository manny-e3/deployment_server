// API tests for /servers. The test-connection cases use the sshd container.
const { TEST_SSH } = require('./setup');
const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { decrypt } = require('../utils/crypto');
const { assertNoEncFields, createUser, login, resetDb } = require('./helpers');

const app = createApp();
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures', 'test_ed25519'), 'utf8');

let admin;
let viewer;

before(resetDb);
after(closeConnections);

beforeEach(async () => {
  await resetDb();
  admin = await login(app, await createUser('ADMIN'));
  viewer = await login(app, await createUser('VIEWER'));
});

const as = (session, method, url) =>
  session.agent[method](`/api/v1${url}`).set('X-CSRF-Token', session.csrf);

const sshdServer = (overrides = {}) => ({
  name: 'Local sshd',
  host: TEST_SSH.host,
  port: TEST_SSH.port,
  username: TEST_SSH.username,
  authType: 'PASSWORD',
  secret: TEST_SSH.password,
  ...overrides,
});

async function createServer(overrides) {
  const res = await as(admin, 'post', '/servers').send(sshdServer(overrides)).expect(201);
  return res.body;
}

describe('servers CRUD', () => {
  it('stores the secret encrypted and never returns it', async () => {
    const res = await as(admin, 'post', '/servers')
      .send(sshdServer({ authType: 'KEY', secret: privateKey, passphrase: 'not-needed' }))
      .expect(201);

    assertNoEncFields(res.body);
    assert.ok(!JSON.stringify(res.body).includes('PRIVATE KEY'));

    const row = await prisma.server.findUnique({ where: { id: res.body.id } });
    assert.match(row.secretEnc, /^v1:/);
    assert.equal(decrypt(row.secretEnc), privateKey);
    assert.equal(decrypt(row.passphraseEnc), 'not-needed');

    const entry = await prisma.auditLog.findFirst({ where: { action: 'server.created' } });
    assert.ok(!JSON.stringify(entry.details).includes('PRIVATE KEY'));
  });

  it('lets viewers list and read servers, without secrets', async () => {
    const server = await createServer();
    const list = await as(viewer, 'get', '/servers').expect(200);
    const one = await as(viewer, 'get', `/servers/${server.id}`).expect(200);
    assertNoEncFields(list.body);
    assertNoEncFields(one.body);
    assert.equal(list.body.items.length, 1);
  });

  it('refuses a KEY server whose secret is not a private key', async () => {
    const res = await as(admin, 'post', '/servers')
      .send(sshdServer({ authType: 'KEY', secret: 'just a password' }))
      .expect(400);
    assert.equal(res.body.error.details.fields[0].field, 'body.secret');
  });

  it('refuses a duplicate name with 409', async () => {
    await createServer();
    await as(admin, 'post', '/servers').send(sshdServer()).expect(409);
  });

  it('updates fields, replaces the secret, and forgets the host key when the host moves', async () => {
    const server = await createServer();
    await prisma.server.update({ where: { id: server.id }, data: { hostFingerprint: 'SHA256:x' } });

    const renamed = await as(admin, 'patch', `/servers/${server.id}`)
      .send({ name: 'Renamed', secret: 'new-password' })
      .expect(200);
    assertNoEncFields(renamed.body);
    assert.equal(renamed.body.hostFingerprint, 'SHA256:x');

    const row = await prisma.server.findUnique({ where: { id: server.id } });
    assert.equal(decrypt(row.secretEnc), 'new-password');

    const moved = await as(admin, 'patch', `/servers/${server.id}`)
      .send({ host: '10.0.0.5' })
      .expect(200);
    assert.equal(moved.body.hostFingerprint, null);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'server.updated' },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(entry.details, { name: { from: 'Local sshd', to: 'Renamed' }, secretChanged: true });
  });

  it('refuses to delete a server while targets use it, then deletes it once they are gone', async () => {
    const server = await createServer();
    const project = await prisma.project.create({
      data: { name: 'Shop', repoUrl: 'git@github.com:acme/shop.git', webhookSecretEnc: 'v1:x:y:z' },
    });
    await prisma.target.create({
      data: {
        projectId: project.id,
        serverId: server.id,
        name: 'Production',
        path: '/var/www/shop',
        preDeploy: '',
        postDeploy: '',
      },
    });

    const res = await as(admin, 'delete', `/servers/${server.id}`).expect(409);
    assert.equal(res.body.error.code, 'SERVER_IN_USE');
    assert.equal(res.body.error.details.targetCount, 1);

    await prisma.target.deleteMany();
    await as(admin, 'delete', `/servers/${server.id}`).expect(204);
    await as(admin, 'get', `/servers/${server.id}`).expect(404);
  });

  it('allows only admins to change servers', async () => {
    const server = await createServer();
    await as(viewer, 'post', '/servers').send(sshdServer({ name: 'x' })).expect(403);
    await as(viewer, 'patch', `/servers/${server.id}`).send({ name: 'x' }).expect(403);
    await as(viewer, 'delete', `/servers/${server.id}`).expect(403);
    await as(viewer, 'post', `/servers/${server.id}/test`).expect(403);
    await as(viewer, 'post', `/servers/${server.id}/reset-fingerprint`).expect(403);
  });
});

describe('POST /servers/:id/test against the sshd container', () => {
  it('exit check: succeeds, reports the machine, and pins the host key on first use', async () => {
    const server = await createServer({ authType: 'KEY', secret: privateKey });

    const res = await as(admin, 'post', `/servers/${server.id}/test`).expect(200);
    assertNoEncFields(res.body);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.whoami, 'deploy');
    assert.match(res.body.gitVersion, /^git version /);
    assert.ok(res.body.freeDiskMb > 0);
    assert.match(res.body.fingerprint, /^SHA256:/);
    assert.equal(res.body.fingerprintPinned, true);

    const saved = await as(admin, 'get', `/servers/${server.id}`).expect(200);
    assert.equal(saved.body.hostFingerprint, res.body.fingerprint);
    assert.equal(saved.body.lastCheckOk, true);

    const again = await as(admin, 'post', `/servers/${server.id}/test`).expect(200);
    assert.equal(again.body.fingerprintPinned, false);
  });

  it('exit check: refuses a changed host key until the fingerprint is reset', async () => {
    const server = await createServer();
    const stale = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await prisma.server.update({ where: { id: server.id }, data: { hostFingerprint: stale } });

    const refused = await as(admin, 'post', `/servers/${server.id}/test`).expect(409);
    assert.equal(refused.body.error.code, 'HOST_KEY_CHANGED');
    assert.equal(refused.body.error.details.expected, stale);
    const failed = await as(admin, 'get', `/servers/${server.id}`);
    assert.equal(failed.body.lastCheckOk, false);

    const reset = await as(admin, 'post', `/servers/${server.id}/reset-fingerprint`).expect(200);
    assert.equal(reset.body.hostFingerprint, null);

    const ok = await as(admin, 'post', `/servers/${server.id}/test`).expect(200);
    assert.equal(ok.body.fingerprintPinned, true);
    assert.equal(ok.body.fingerprint, refused.body.error.details.received);

    const resets = await prisma.auditLog.count({ where: { action: 'server.fingerprint_reset' } });
    assert.equal(resets, 1);
  });

  it('reports a wrong password as 422 SSH_AUTH_FAILED', async () => {
    const server = await createServer({ secret: 'wrong-password' });
    const res = await as(admin, 'post', `/servers/${server.id}/test`).expect(422);
    assert.equal(res.body.error.code, 'SSH_AUTH_FAILED');
    assert.ok(!JSON.stringify(res.body).includes('wrong-password'));
  });

  it('reports an unreachable server as 422 SSH_UNREACHABLE', async () => {
    const server = await createServer({ port: 1 });
    const res = await as(admin, 'post', `/servers/${server.id}/test`).expect(422);
    assert.equal(res.body.error.code, 'SSH_UNREACHABLE');
  });
});
