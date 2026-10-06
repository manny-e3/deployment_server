// "Deploy to all" rolls out a few targets at a time, not all at once.
require('./setup');
const { after, before, it } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('bullmq');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { runDeployment } = require('../jobs/deploy.job');
const { closeConnections } = require('../utils/connections');
const { DEPLOY_QUEUE } = require('../utils/queue');
const { createRedisConnection } = require('../utils/redis');
const { createUser, login, resetDb } = require('./helpers');
const { createFixtures, createRepo, sleep } = require('./deployHelpers');

const app = createApp();
let worker;
let workerConnection;

before(async () => {
  await resetDb();
  await createRepo();
  workerConnection = createRedisConnection('test-worker');
  worker = new Worker(
    DEPLOY_QUEUE,
    (job) => runDeployment(job.data.deploymentId, { projectConcurrency: 2, slotPollMs: 200 }),
    { connection: workerConnection, concurrency: 5, maxStalledCount: 0 },
  );
});

after(async () => {
  await worker.close(true);
  await workerConnection.quit();
  await resetDb();
  await closeConnections();
});

it('deploys all 4 targets with at most 2 running at once', async () => {
  const fixtures = await createFixtures();
  for (let i = 0; i < 4; i += 1) await fixtures.makeTarget({ postDeploy: 'sleep 1.5' });
  const deployer = await login(app, await createUser('DEPLOYER'));

  const res = await deployer.agent
    .post(`/api/v1/projects/${fixtures.project.id}/deploy`)
    .set('X-CSRF-Token', deployer.csrf)
    .send({}) // no targetIds: every target
    .expect(202);
  assert.equal(res.body.started.length, 4);

  let maxRunning = 0;
  for (;;) {
    const counts = await prisma.deployment.groupBy({ by: ['status'], _count: true });
    const n = (s) => counts.find((c) => c.status === s)?._count ?? 0;
    maxRunning = Math.max(maxRunning, n('RUNNING'));
    if (n('SUCCESS') + n('FAILED') === 4) break;
    await sleep(100);
  }
  assert.equal(maxRunning, 2);
  assert.equal(await prisma.deployment.count({ where: { status: 'SUCCESS' } }), 4);
});
