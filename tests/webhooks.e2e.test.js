// GitHub and GitLab webhooks. The exit-check case deploys a real push to the sshd container.
require('./setup');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { Worker } = require('bullmq');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { runDeployment } = require('../jobs/deploy.job');
const { closeConnections } = require('../utils/connections');
const { encrypt } = require('../utils/crypto');
const { DEPLOY_QUEUE } = require('../utils/queue');
const { createRedisConnection } = require('../utils/redis');
const { resetDb } = require('./helpers');
const { createFixtures, createRepo, pushCommit, remote, waitForStatus } = require('./deployHelpers');

const app = createApp();
const SECRET = 'a-webhook-secret-for-tests';
let fixtures;
let worker;
let workerConnection;

before(async () => {
  await resetDb();
  await createRepo();
  fixtures = await createFixtures();
  await prisma.project.update({
    where: { id: fixtures.project.id },
    data: { webhookSecretEnc: encrypt(SECRET), autoDeploy: true },
  });
  await fixtures.makeTarget({ postDeploy: 'cat version.txt' }); // deploys main
  await fixtures.makeTarget({ branch: 'develop' }); // must not deploy on a push to main

  workerConnection = createRedisConnection('test-worker');
  worker = new Worker(DEPLOY_QUEUE, (job) => runDeployment(job.data.deploymentId), {
    connection: workerConnection,
    concurrency: 5,
    maxStalledCount: 0,
  });
});

after(async () => {
  await worker.close(true);
  await workerConnection.quit();
  await resetDb();
  await closeConnections();
});

const sign = (body, secret = SECRET) =>
  `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

function github(body, { event = 'push', delivery = crypto.randomUUID(), signature, projectId } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return request(app)
    .post(`/api/v1/webhooks/github/${projectId ?? fixtures.project.id}`)
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', delivery)
    .set('X-Hub-Signature-256', signature ?? sign(raw))
    .send(raw);
}

const push = (sha, branch = 'main') => ({ ref: `refs/heads/${branch}`, after: sha });
const webhookDeploys = () => prisma.deployment.count({ where: { trigger: 'WEBHOOK' } });

describe('GitHub webhook', () => {
  it('exit check: a push to the right branch deploys once, even when GitHub resends it', async () => {
    const sha = await pushCommit('v2');
    const body = JSON.stringify(push(sha));
    const delivery = crypto.randomUUID();

    const first = await github(body, { delivery }).expect(202);
    assert.equal(first.body.started.length, 1, 'only the target on main');
    const resent = await github(body, { delivery }).expect(200);
    assert.match(resent.body.result, /duplicate/);

    const done = await waitForStatus(first.body.started[0].id, ['SUCCESS', 'FAILED']);
    assert.equal(done.status, 'SUCCESS');
    assert.equal(done.trigger, 'WEBHOOK');
    assert.equal(done.commitSha, sha);
    assert.equal(done.triggeredById, null);
    assert.equal(await webhookDeploys(), 1);

    const record = await prisma.webhookDelivery.findUnique({ where: { deliveryId: `github:${delivery}` } });
    assert.equal(record.statusCode, 202);
    assert.equal(record.branch, 'main');
    assert.equal(await remote(`cat ${fixtures.project.repoUrl.replace('app.git', 'site-1')}/version.txt`), 'v2');
  });

  it('exit check: a wrong signature is refused and recorded, and nothing deploys', async () => {
    const body = JSON.stringify(push('a'.repeat(40)));
    const cases = [
      github(body, { signature: sign(body, 'some-other-secret') }),
      github(body, { signature: 'sha256=' }),
      github(body, { signature: sign('{"tampered":true}') }),
      request(app)
        .post(`/api/v1/webhooks/github/${fixtures.project.id}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'push')
        .send(body), // no signature at all
    ];
    for (const res of await Promise.all(cases)) {
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_SIGNATURE');
    }
    assert.equal(await webhookDeploys(), 1);
    const refused = await prisma.webhookDelivery.findMany({ where: { statusCode: 401 } });
    assert.equal(refused.length, 4);
    assert.ok(refused.every((r) => r.deliveryId === null));
  });

  it('answers ping, and ignores other events, branches, tags, deletions and non-JSON', async () => {
    const sha = 'b'.repeat(40);
    assert.equal((await github({ zen: 'hi' }, { event: 'ping' }).expect(200)).body.result, 'pong');
    assert.match((await github(push(sha), { event: 'issues' }).expect(200)).body.result, /ignored: issues/);
    assert.match((await github(push(sha, 'feature/x')).expect(200)).body.result, /no target deploys feature\/x/);
    assert.match(
      (await github({ ref: 'refs/tags/v1.0.0', after: sha }).expect(200)).body.result,
      /not a branch push/,
    );
    assert.match((await github(push('0'.repeat(40))).expect(200)).body.result, /branch deleted/);

    const form = await request(app)
      .post(`/api/v1/webhooks/github/${fixtures.project.id}`)
      .type('form')
      .send({ payload: '{}' })
      .expect(415);
    assert.equal(form.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(await webhookDeploys(), 1);
  });

  it('does nothing while auto-deploy is off', async () => {
    await prisma.project.update({ where: { id: fixtures.project.id }, data: { autoDeploy: false } });
    try {
      const res = await github(push('c'.repeat(40))).expect(200);
      assert.match(res.body.result, /auto-deploy is off/);
    } finally {
      await prisma.project.update({ where: { id: fixtures.project.id }, data: { autoDeploy: true } });
    }
  });

  it('returns 404 for an unknown project', async () => {
    await github(push('d'.repeat(40)), { projectId: 'ckx9z0q8h0000abcd' }).expect(404);
    await github(push('d'.repeat(40)), { projectId: 'not-an-id' }).expect(404);
  });
});

describe('GitLab webhook', () => {
  const gitlab = (body, token = SECRET, uuid = crypto.randomUUID()) =>
    request(app)
      .post(`/api/v1/webhooks/gitlab/${fixtures.project.id}`)
      .set('Content-Type', 'application/json')
      .set('X-Gitlab-Event', 'Push Hook')
      .set('X-Gitlab-Event-UUID', uuid)
      .set('X-Gitlab-Token', token)
      .send(JSON.stringify(body));

  it('deploys a push with the right token, once per delivery', async () => {
    const sha = await pushCommit('v3');
    const uuid = crypto.randomUUID();
    const res = await gitlab(push(sha), SECRET, uuid).expect(202);
    await gitlab(push(sha), SECRET, uuid).expect(200);
    const done = await waitForStatus(res.body.started[0].id, ['SUCCESS', 'FAILED']);
    assert.equal(done.commitSha, sha);
  });

  it('refuses a wrong token', async () => {
    const res = await gitlab(push('e'.repeat(40)), 'wrong').expect(401);
    assert.equal(res.body.error.code, 'INVALID_SIGNATURE');
  });
});

describe('webhook rate limit', () => {
  it('allows 60 deliveries per minute per project', async () => {
    const other = await prisma.project.create({
      data: { name: 'Busy', repoUrl: 'git@x:y.git', webhookSecretEnc: encrypt(SECRET) },
    });
    const send = () =>
      request(app)
        .post(`/api/v1/webhooks/github/${other.id}`)
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'ping')
        .send('{}');
    const statuses = [];
    for (let i = 0; i < 61; i += 1) statuses.push((await send()).status);
    assert.ok(statuses.slice(0, 60).every((s) => s === 401));
    assert.equal(statuses[60], 429);
  });
});
