require('./setup');
const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { decrypt, encrypt } = require('../utils/crypto');
const { assertNoEncFields, createUser, login, resetDb } = require('./helpers');

const app = createApp();
const ID = 'ckx9z0q8h0000abcd';

let admin;
let viewer;
let server;

before(resetDb);
after(closeConnections);

beforeEach(async () => {
  await resetDb();
  admin = await login(app, await createUser('ADMIN'));
  viewer = await login(app, await createUser('VIEWER'));
  server = await prisma.server.create({
    data: {
      name: 'Web 1',
      host: '10.0.0.1',
      username: 'deploy',
      authType: 'PASSWORD',
      secretEnc: encrypt('x'),
    },
  });
});

// Sends a request as a session and checks the body never leaks an encrypted field.
function as(session, method, url) {
  const req = session.agent[method](`/api/v1${url}`).set('X-CSRF-Token', session.csrf);
  const originalThen = req.then.bind(req);
  req.then = (resolve, reject) =>
    originalThen((res) => {
      assertNoEncFields(res.body);
      return res;
    }).then(resolve, reject);
  return req;
}

const shop = { name: 'Shop', repoUrl: 'git@github.com:acme/shop.git' };
const target = (overrides = {}) => ({
  name: 'Production',
  serverId: server.id,
  path: '/var/www/shop',
  postDeploy: 'npm ci && pm2 reload shop',
  ...overrides,
});

async function createProject(body = shop) {
  return (await as(admin, 'post', '/projects').send(body).expect(201)).body;
}

describe('projects and targets', () => {
  it('exit check: an admin configures a project with two targets', async () => {
    const project = await createProject({ ...shop, defaultBranch: 'main', autoDeploy: true });
    assert.match(project.webhookSecret, /^[0-9a-f]{64}$/);

    const row = await prisma.project.findUnique({ where: { id: project.id } });
    assert.equal(decrypt(row.webhookSecretEnc), project.webhookSecret);

    const prod = await as(admin, 'post', `/projects/${project.id}/targets`)
      .send(target())
      .expect(201);
    const staging = await as(admin, 'post', `/projects/${project.id}/targets`)
      .send(target({ name: 'Staging', path: '/var/www/shop-staging', branch: 'develop' }))
      .expect(201);
    assert.equal(prod.body.preDeploy, '');
    assert.equal(staging.body.branch, 'develop');

    const detail = await as(viewer, 'get', `/projects/${project.id}`).expect(200);
    assert.equal(detail.body.webhookSecret, undefined);
    assert.deepEqual(
      detail.body.targets.map((t) => [t.name, t.server.name, t.lastDeploy]),
      [
        ['Production', 'Web 1', null],
        ['Staging', 'Web 1', null],
      ],
    );
    assert.equal(detail.body.targets[0].postDeploy, 'npm ci && pm2 reload shop');

    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action);
    assert.ok(actions.includes('project.created'));
    assert.equal(actions.filter((a) => a === 'target.created').length, 2);
  });

  it('lists projects with the last deploy of each target', async () => {
    const project = await createProject();
    const t = await as(admin, 'post', `/projects/${project.id}/targets`).send(target()).expect(201);
    const base = { targetId: t.body.id, trigger: 'MANUAL', branch: 'main' };
    await prisma.deployment.create({
      data: { ...base, status: 'SUCCESS', queuedAt: new Date('2026-10-01T10:00:00Z') },
    });
    const newest = await prisma.deployment.create({
      data: { ...base, status: 'FAILED', queuedAt: new Date('2026-10-02T10:00:00Z') },
    });

    const res = await as(viewer, 'get', '/projects').expect(200);
    assert.equal(res.body.items.length, 1);
    const last = res.body.items[0].targets[0].lastDeploy;
    assert.equal(last.id, newest.id);
    assert.equal(last.status, 'FAILED');
    assert.equal(res.body.items[0].targets[0].postDeploy, undefined); // summary only
  });

  it('records what changed when a target is updated, including its commands', async () => {
    const project = await createProject();
    const t = await as(admin, 'post', `/projects/${project.id}/targets`).send(target()).expect(201);

    await as(admin, 'patch', `/projects/${project.id}/targets/${t.body.id}`)
      .send({ postDeploy: 'npm ci && npm run build', healthCheckUrl: 'https://shop.example.com/up' })
      .expect(200);

    const entry = await prisma.auditLog.findFirst({ where: { action: 'target.updated' } });
    assert.deepEqual(entry.details, {
      projectId: project.id,
      postDeploy: { from: 'npm ci && pm2 reload shop', to: 'npm ci && npm run build' },
      healthCheckUrl: { from: null, to: 'https://shop.example.com/up' },
    });
  });

  it('refuses unsafe paths and branch names', async () => {
    const project = await createProject();
    const url = `/projects/${project.id}/targets`;
    for (const path of ['var/www/shop', '/var/www/../etc', '/', '/var/www/shop; rm -rf /', '/a b']) {
      const res = await as(admin, 'post', url).send(target({ path })).expect(400);
      assert.equal(res.body.error.details.fields[0].field, 'body.path', path);
    }
    for (const branch of ['main;reboot', 'feature/../x', '-rf', 'a b', '$(id)']) {
      const res = await as(admin, 'post', url).send(target({ branch })).expect(400);
      assert.equal(res.body.error.details.fields[0].field, 'body.branch', branch);
    }
    await as(admin, 'post', '/projects').send({ ...shop, defaultBranch: 'x..y' }).expect(400);
    await as(admin, 'post', '/projects').send({ ...shop, repoUrl: 'git@x:y.git; rm -rf ~' }).expect(400);
  });

  it('refuses two targets in the same folder on the same server', async () => {
    const project = await createProject();
    const other = await createProject({ name: 'Blog', repoUrl: 'https://github.com/acme/blog.git' });
    await as(admin, 'post', `/projects/${project.id}/targets`).send(target()).expect(201);
    const res = await as(admin, 'post', `/projects/${other.id}/targets`).send(target()).expect(409);
    assert.equal(res.body.error.code, 'ALREADY_EXISTS');
  });

  it('refuses a target on an unknown server, and targets of another project', async () => {
    const project = await createProject();
    const other = await createProject({ name: 'Blog', repoUrl: 'https://github.com/acme/blog.git' });
    const unknown = await as(admin, 'post', `/projects/${project.id}/targets`)
      .send(target({ serverId: ID }))
      .expect(422);
    assert.equal(unknown.body.error.code, 'UNKNOWN_SERVER');

    const t = await as(admin, 'post', `/projects/${project.id}/targets`).send(target()).expect(201);
    await as(admin, 'patch', `/projects/${other.id}/targets/${t.body.id}`)
      .send({ name: 'x' })
      .expect(404);
    await as(admin, 'delete', `/projects/${other.id}/targets/${t.body.id}`).expect(404);
  });

  it('refuses to delete a project or target while a deploy is running', async () => {
    const project = await createProject();
    const t = await as(admin, 'post', `/projects/${project.id}/targets`).send(target()).expect(201);
    await prisma.target.update({ where: { id: t.body.id }, data: { activeDeploymentId: 'cbusy' } });

    const p = await as(admin, 'delete', `/projects/${project.id}`).expect(409);
    assert.equal(p.body.error.code, 'DEPLOY_RUNNING');
    await as(admin, 'delete', `/projects/${project.id}/targets/${t.body.id}`).expect(409);

    await prisma.target.update({ where: { id: t.body.id }, data: { activeDeploymentId: null } });
    await as(admin, 'delete', `/projects/${project.id}/targets/${t.body.id}`).expect(204);
    await as(admin, 'delete', `/projects/${project.id}`).expect(204);
    await as(admin, 'get', `/projects/${project.id}`).expect(404);
  });

  it('regenerates the webhook secret and returns it once', async () => {
    const project = await createProject();
    const res = await as(admin, 'post', `/projects/${project.id}/webhook-secret`).expect(200);
    assert.match(res.body.webhookSecret, /^[0-9a-f]{64}$/);
    assert.notEqual(res.body.webhookSecret, project.webhookSecret);

    const row = await prisma.project.findUnique({ where: { id: project.id } });
    assert.equal(decrypt(row.webhookSecretEnc), res.body.webhookSecret);
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'project.webhook_secret_regenerated' },
    });
    assert.ok(!JSON.stringify(entry.details ?? {}).includes(res.body.webhookSecret));
  });

  it('allows viewers to read but not to change projects', async () => {
    const project = await createProject();
    await as(viewer, 'get', '/projects').expect(200);
    await as(viewer, 'get', `/projects/${project.id}`).expect(200);
    await as(viewer, 'post', '/projects').send(shop).expect(403);
    await as(viewer, 'post', `/projects/${project.id}/targets`).send(target()).expect(403);
    await as(viewer, 'post', `/projects/${project.id}/webhook-secret`).expect(403);
  });
});

describe('target env vars', () => {
  let targetId;

  beforeEach(async () => {
    const project = await createProject();
    targetId = (await as(admin, 'post', `/projects/${project.id}/targets`).send(target()).expect(201))
      .body.id;
  });

  it('replaces the whole set, stores values encrypted, and only ever returns the keys', async () => {
    const put = await as(admin, 'put', `/targets/${targetId}/env`)
      .send({ vars: { DATABASE_URL: 'mysql://u:hunter2@db/shop', APP_KEY: 'base64:abc' } })
      .expect(200);
    assert.deepEqual(put.body, { keys: ['APP_KEY', 'DATABASE_URL'] });

    const get = await as(admin, 'get', `/targets/${targetId}/env`).expect(200);
    assert.deepEqual(get.body, { keys: ['APP_KEY', 'DATABASE_URL'] });
    assert.ok(!JSON.stringify(get.body).includes('hunter2'));

    const rows = await prisma.envVar.findMany({ where: { targetId }, orderBy: { key: 'asc' } });
    assert.ok(rows.every((r) => r.valueEnc.startsWith('v1:')));
    assert.equal(decrypt(rows[1].valueEnc), 'mysql://u:hunter2@db/shop');

    // A second PUT is the new full set: APP_KEY goes, DATABASE_URL changes, PORT is added.
    await as(admin, 'put', `/targets/${targetId}/env`)
      .send({ vars: { DATABASE_URL: 'mysql://u:new@db/shop', PORT: '3000' } })
      .expect(200);
    const keys = await as(admin, 'get', `/targets/${targetId}/env`);
    assert.deepEqual(keys.body.keys, ['DATABASE_URL', 'PORT']);

    const entries = await prisma.auditLog.findMany({
      where: { action: 'target.env_replaced' },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(entries[1].details.added, ['PORT']);
    assert.deepEqual(entries[1].details.removed, ['APP_KEY']);
    assert.deepEqual(entries[1].details.changed, ['DATABASE_URL']);
    assert.ok(!JSON.stringify(entries.map((e) => e.details)).includes('hunter2'));
  });

  it('refuses invalid env var names', async () => {
    const res = await as(admin, 'put', `/targets/${targetId}/env`)
      .send({ vars: { 'BAD-NAME': 'x' } })
      .expect(400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  it('is admin-only, even to read the names', async () => {
    await as(viewer, 'get', `/targets/${targetId}/env`).expect(403);
    await as(viewer, 'put', `/targets/${targetId}/env`).send({ vars: {} }).expect(403);
  });
});
