require('./setup');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { purgeOldLogs } = require('../services/retention.service');
const { encrypt } = require('../utils/crypto');
const { createUser, login, resetDb } = require('./helpers');

const app = createApp();
const APP_URL = process.env.APP_URL;

before(resetDb);
after(async () => {
  await resetDb();
  await closeConnections();
});

describe('HTTP hardening', () => {
  it('sends Helmet security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['strict-transport-security']);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('allows cross-origin calls only from APP_URL', async () => {
    const ours = await request(app).get('/api/v1/health').set('Origin', APP_URL);
    assert.equal(ours.headers['access-control-allow-origin'], APP_URL);
    assert.equal(ours.headers['access-control-allow-credentials'], 'true');

    const theirs = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    assert.notEqual(theirs.headers['access-control-allow-origin'], 'https://evil.example');
  });

  it('refuses a JSON body over 1 MB', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(1_100_000) }))
      .expect(413);
    assert.equal(res.body.error.code, 'PAYLOAD_TOO_LARGE');
  });

  it('allows 300 API requests per minute per user', async () => {
    const { agent } = await login(app, await createUser('VIEWER'));
    const statuses = [];
    for (let batch = 0; batch < 6; batch += 1) {
      const results = await Promise.all(Array.from({ length: 50 }, () => agent.get('/api/v1/auth/me')));
      statuses.push(...results.map((r) => r.status));
    }
    assert.ok(statuses.every((s) => s === 200), 'first 300 pass');
    const over = await agent.get('/api/v1/auth/me').expect(429);
    assert.equal(over.body.error.code, 'RATE_LIMITED');

    // Other users are not affected.
    const other = await login(app, await createUser('VIEWER'));
    await other.agent.get('/api/v1/auth/me').expect(200);
  });
});

describe('GET /audit-logs', () => {
  it('is admin-only, filters by action prefix and user, and pages with a cursor', async () => {
    const adminUser = await createUser('ADMIN');
    const admin = await login(app, adminUser);
    const viewer = await login(app, await createUser('VIEWER'));
    await viewer.agent.get('/api/v1/audit-logs').expect(403);

    const first = await admin.agent.get('/api/v1/audit-logs?action=auth.*&limit=2').expect(200);
    assert.equal(first.body.items.length, 2);
    assert.ok(first.body.items.every((e) => e.action.startsWith('auth.')));
    assert.equal(typeof first.body.items[0].id, 'string');
    assert.ok(first.body.nextCursor);

    const next = await admin.agent
      .get(`/api/v1/audit-logs?action=auth.*&limit=2&cursor=${first.body.nextCursor}`)
      .expect(200);
    assert.ok(BigInt(next.body.items[0].id) < BigInt(first.body.items[1].id), 'older entries');

    const mine = await admin.agent.get(`/api/v1/audit-logs?userId=${adminUser.id}`).expect(200);
    assert.ok(mine.body.items.length >= 1);
    assert.ok(mine.body.items.every((e) => e.user.id === adminUser.id));
  });
});

describe('log retention', () => {
  it('deletes log lines older than the retention period and keeps the deployments', async () => {
    const server = await prisma.server.create({
      data: { name: 's', host: 'h', username: 'u', authType: 'PASSWORD', secretEnc: encrypt('x') },
    });
    const project = await prisma.project.create({
      data: { name: 'p', repoUrl: 'git@x:y.git', webhookSecretEnc: encrypt('x') },
    });
    const target = await prisma.target.create({
      data: { projectId: project.id, serverId: server.id, name: 't', path: '/a', preDeploy: '', postDeploy: '' },
    });
    const d = await prisma.deployment.create({ data: { targetId: target.id, trigger: 'MANUAL', branch: 'main' } });
    const now = new Date('2026-10-05T03:00:00Z');
    const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);
    await prisma.deploymentLog.createMany({
      data: [
        { deploymentId: d.id, seq: 1, stream: 'STDOUT', line: 'old', createdAt: daysAgo(120) },
        { deploymentId: d.id, seq: 2, stream: 'STDOUT', line: 'just old', createdAt: daysAgo(91) },
        { deploymentId: d.id, seq: 3, stream: 'STDOUT', line: 'recent', createdAt: daysAgo(89) },
      ],
    });

    assert.equal(await purgeOldLogs(90, now), 2);
    const left = await prisma.deploymentLog.findMany({ where: { deploymentId: d.id } });
    assert.deepEqual(left.map((l) => l.line), ['recent']);
    assert.ok(await prisma.deployment.findUnique({ where: { id: d.id } }));
  });
});
