// Exit check: killing the worker mid-deploy leaves no deploy stuck as "running".
// Runs the real worker.js as a child process and kills it.
require('./setup');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { recoverStuckDeploys } = require('../services/recovery.service');
const { closeConnections } = require('../utils/connections');
const { deployQueue } = require('../utils/queue');
const { createUser, login, resetDb } = require('./helpers');
const { createFixtures, createRepo, remote, sleep, waitForLog, waitForStatus } = require('./deployHelpers');

const app = createApp();
const children = new Set();
let fixtures;
let deployer;

function startWorker() {
  const child = spawn(process.execPath, ['worker.js'], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'ignore',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

const kill = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });

before(async () => {
  await resetDb();
  await createRepo();
  fixtures = await createFixtures();
  deployer = await login(app, await createUser('DEPLOYER'));
});

after(async () => {
  await Promise.all([...children].map(kill));
  await remote(`pkill -f 'sleep 3[0-9]' || true`);
  await resetDb();
  await closeConnections();
});

describe('worker recovery', () => {
  it('exit check: a deploy running when the worker dies is failed when it restarts', async () => {
    const target = await fixtures.makeTarget({ postDeploy: 'echo started\nsleep 33' });
    const res = await deployer.agent
      .post(`/api/v1/projects/${fixtures.project.id}/deploy`)
      .set('X-CSRF-Token', deployer.csrf)
      .send({ targetIds: [target.id] })
      .expect(202);
    const { id } = res.body.started[0];

    const first = startWorker();
    await waitForLog(id, 'started');
    await kill(first);

    await sleep(500);
    const stuck = await prisma.deployment.findUnique({ where: { id } });
    assert.equal(stuck.status, 'RUNNING', 'nothing else can finish it');

    startWorker();
    const done = await waitForStatus(id, ['FAILED']);
    assert.equal(done.error, 'WORKER_RESTARTED');
    assert.ok(done.finishedAt);
    const row = await prisma.target.findUnique({ where: { id: target.id } });
    assert.equal(row.activeDeploymentId, null);
  });

  it('fails a queued deploy whose job is gone, and clears its lock', async () => {
    const target = await fixtures.makeTarget();
    const d = await prisma.deployment.create({
      data: { targetId: target.id, trigger: 'MANUAL', branch: 'main' },
    });
    await prisma.target.update({ where: { id: target.id }, data: { activeDeploymentId: d.id } });

    const { failed } = await recoverStuckDeploys(deployQueue);
    assert.ok(failed.includes(d.id));
    const row = await prisma.deployment.findUnique({ where: { id: d.id } });
    assert.equal(row.status, 'FAILED');
    assert.equal(row.error, 'WORKER_RESTARTED');
    assert.equal((await prisma.target.findUnique({ where: { id: target.id } })).activeDeploymentId, null);
  });
});
