// End-to-end deploys against the sshd container: API -> queue -> worker -> SSH -> git.
// The worker runs inside this test process, so its time limits can be shortened.
require('./setup');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Worker } = require('bullmq');
const { io: ioClient } = require('socket.io-client');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { runDeployment } = require('../jobs/deploy.job');
const { closeConnections } = require('../utils/connections');
const { DEPLOY_QUEUE, deployQueue } = require('../utils/queue');
const { createRedisConnection } = require('../utils/redis');
const { createSocketServer } = require('../utils/socket');
const { cookieFrom, createUser, login, resetDb } = require('./helpers');
const {
  E2E_DIR,
  createFixtures,
  createRepo,
  logLines,
  pushCommit,
  remote,
  waitFor,
  waitForLog,
  waitForStatus,
} = require('./deployHelpers');

const app = createApp();
const workerOptions = {}; // tests change timeoutMs / healthCheck here
let worker;
let workerConnection;
let admin;
let deployer;
let viewer;
let fixtures;
let firstSha;

before(async () => {
  await resetDb();
  firstSha = await createRepo();
  fixtures = await createFixtures();
  admin = await login(app, await createUser('ADMIN'));
  deployer = await login(app, await createUser('DEPLOYER'));
  viewer = await login(app, await createUser('VIEWER'));

  workerConnection = createRedisConnection('test-worker');
  worker = new Worker(DEPLOY_QUEUE, (job) => runDeployment(job.data.deploymentId, workerOptions), {
    connection: workerConnection,
    concurrency: 5,
    maxStalledCount: 0,
  });
});

after(async () => {
  await worker.close(true);
  await workerConnection.quit();
  await remote(`pkill -f 'sleep 3[0-9]' || true`);
  await resetDb();
  await closeConnections();
});

const api = (session, method, url) =>
  session.agent[method](`/api/v1${url}`).set('X-CSRF-Token', session.csrf);

async function deploy(target, body = {}, session = deployer) {
  const res = await api(session, 'post', `/projects/${fixtures.project.id}/deploy`)
    .send({ targetIds: [target.id], ...body })
    .expect(202);
  assert.equal(res.body.started.length, 1, JSON.stringify(res.body));
  return res.body.started[0];
}

const visible = async (id) => (await logLines(id)).map((l) => `${l.stream}: ${l.line}`);

describe('deploys over SSH', () => {
  let site; // target reused by first deploy, update and rollback
  let firstDeployment;

  it('first deploy: clones the repo, writes .env and reports the commit', async () => {
    site = await fixtures.makeTarget({ postDeploy: 'cat version.txt' });
    await api(admin, 'put', `/targets/${site.id}/env`)
      .send({ vars: { DB_PASSWORD: `p"a'ss $(touch ${E2E_DIR}/pwned)`, PORT: '3000' } })
      .expect(200);

    const started = await deploy(site);
    const done = await waitForStatus(started.id, ['SUCCESS', 'FAILED']);
    firstDeployment = done;

    const lines = await visible(started.id);
    assert.equal(done.status, 'SUCCESS', lines.join('\n'));
    assert.equal(done.commitSha, firstSha);
    assert.equal(done.commitMessage, 'first version');
    assert.equal(done.previousSha, null);
    assert.ok(lines.includes('STDOUT: v1'));
    assert.ok(lines.some((l) => l.startsWith('SYSTEM: Fetching main')));
    assert.ok(lines.some((l) => l.startsWith('SYSTEM: Deploying commit')));
    assert.ok(!lines.some((l) => l.includes('__PID__') || l.includes('__COMMIT__')), 'markers hidden');
    assert.ok(!lines.some((l) => l.includes('p"a')), 'env values never logged');

    const envFile = await remote(`cd ${site.path} && stat -c %a .env && cat .env && ls ${E2E_DIR}`);
    assert.match(envFile, /^600\n/);
    assert.ok(envFile.includes(`DB_PASSWORD="p\\"a'ss $(touch ${E2E_DIR}/pwned)"`));
    assert.ok(!envFile.split('\n').includes('pwned'), 'the value was written, never run');

    const target = await prisma.target.findUnique({ where: { id: site.id } });
    assert.equal(target.activeDeploymentId, null, 'lock released');
  });

  it('update: deploys the new commit and remembers the previous one', async () => {
    const secondSha = await pushCommit('v2');
    const started = await deploy(site);
    const done = await waitForStatus(started.id, ['SUCCESS', 'FAILED']);
    assert.equal(done.status, 'SUCCESS');
    assert.equal(done.commitSha, secondSha);
    assert.equal(done.previousSha, firstSha);
    assert.equal(await remote(`cat ${site.path}/version.txt`), 'v2');
  });

  it('rollback: redeploys the exact earlier commit as a new deployment', async () => {
    const res = await api(deployer, 'post', `/deployments/${firstDeployment.id}/rollback`).expect(202);
    const done = await waitForStatus(res.body.id, ['SUCCESS', 'FAILED']);
    assert.equal(done.status, 'SUCCESS');
    assert.equal(done.trigger, 'ROLLBACK');
    assert.equal(done.requestedSha, firstSha);
    assert.equal(done.commitSha, firstSha);
    assert.equal(await remote(`cat ${site.path}/version.txt`), 'v1');
  });

  it('failure: a non-zero exit fails the deploy and keeps stderr', async () => {
    const target = await fixtures.makeTarget({ postDeploy: 'echo boom >&2\nexit 7' });
    const started = await deploy(target);
    const done = await waitForStatus(started.id, ['SUCCESS', 'FAILED']);
    assert.equal(done.status, 'FAILED');
    assert.equal(done.exitCode, 7);
    const lines = await visible(started.id);
    assert.ok(lines.includes('STDERR: boom'));

    const rollback = await api(deployer, 'post', `/deployments/${started.id}/rollback`).expect(422);
    assert.equal(rollback.body.error.code, 'NOT_ROLLBACKABLE');
  });

  it('cancel: stops a running deploy and the command on the server', async () => {
    const target = await fixtures.makeTarget({ postDeploy: 'echo started\nsleep 31\necho never' });
    const started = await deploy(target);
    await waitForLog(started.id, 'started');

    const res = await api(deployer, 'post', `/deployments/${started.id}/cancel`).expect(202);
    assert.equal(res.body.status, 'CANCELLING');
    const done = await waitForStatus(started.id, ['CANCELLED', 'FAILED', 'SUCCESS']);
    assert.equal(done.status, 'CANCELLED');
    assert.ok(!(await visible(started.id)).includes('STDOUT: never'));
    assert.equal(await remote(`pgrep -f 'sleep 31' || echo none`), 'none', 'remote command killed');
    await api(deployer, 'post', `/deployments/${started.id}/cancel`).expect(422);
  });

  it('cancel: a deploy still in the queue is cancelled at once', async () => {
    const target = await fixtures.makeTarget();
    await deployQueue.pause(); // jobs wait in the queue; no worker takes them
    try {
      const started = await deploy(target);
      const res = await api(deployer, 'post', `/deployments/${started.id}/cancel`).expect(202);
      assert.equal(res.body.status, 'CANCELLED');
      const row = await prisma.target.findUnique({ where: { id: target.id } });
      assert.equal(row.activeDeploymentId, null);
    } finally {
      await deployQueue.resume();
    }
  });

  it('timeout: a deploy over the time limit is stopped and failed', async () => {
    const target = await fixtures.makeTarget({ postDeploy: 'sleep 32' });
    workerOptions.timeoutMs = 2000;
    try {
      const started = await deploy(target);
      const done = await waitForStatus(started.id, ['FAILED', 'SUCCESS']);
      assert.equal(done.status, 'FAILED');
      assert.equal(done.error, 'TIMEOUT');
      assert.equal(await remote(`pgrep -f 'sleep 32' || echo none`), 'none');
    } finally {
      delete workerOptions.timeoutMs;
    }
  });

  it('host key change: the deploy is refused before anything runs', async () => {
    const stale = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const { hostFingerprint } = await prisma.server.findUnique({ where: { id: fixtures.server.id } });
    await prisma.server.update({ where: { id: fixtures.server.id }, data: { hostFingerprint: stale } });
    try {
      const target = await fixtures.makeTarget();
      const started = await deploy(target);
      const done = await waitForStatus(started.id, ['FAILED', 'SUCCESS']);
      assert.equal(done.error, 'HOST_KEY_CHANGED');
      assert.ok((await visible(started.id)).some((l) => l.includes('Deploy refused')));
    } finally {
      await prisma.server.update({ where: { id: fixtures.server.id }, data: { hostFingerprint } });
    }
  });

  it('health check: passes on a 2xx answer and fails the deploy otherwise', async () => {
    const health = http.createServer((req, res) => {
      res.writeHead(req.url === '/up' ? 200 : 503).end();
    });
    await new Promise((r) => health.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${health.address().port}`;
    workerOptions.healthCheck = { attempts: 2, intervalMs: 100 };
    try {
      const ok = await deploy(await fixtures.makeTarget({ healthCheckUrl: `${base}/up` }));
      assert.equal((await waitForStatus(ok.id, ['SUCCESS', 'FAILED'])).status, 'SUCCESS');

      const bad = await deploy(await fixtures.makeTarget({ healthCheckUrl: `${base}/down` }));
      const done = await waitForStatus(bad.id, ['SUCCESS', 'FAILED']);
      assert.equal(done.error, 'HEALTH_CHECK_FAILED');
      assert.ok((await visible(bad.id)).includes('SYSTEM: Health check 2/2: HTTP 503'));
    } finally {
      delete workerOptions.healthCheck;
      health.close();
    }
  });
});

describe('deploy API', () => {
  it('exit check: two clicks at the same moment start only one deploy', async () => {
    const target = await fixtures.makeTarget({ postDeploy: 'sleep 1' });
    const click = () =>
      api(deployer, 'post', `/projects/${fixtures.project.id}/deploy`).send({ targetIds: [target.id] });
    // Five, to make a race likely; each must answer 202 cleanly.
    const responses = await Promise.all(Array.from({ length: 5 }, click));
    assert.deepEqual(responses.map((r) => r.status), [202, 202, 202, 202, 202]);

    const started = responses.flatMap((r) => r.body.started);
    const skipped = responses.flatMap((r) => r.body.skipped);
    assert.equal(started.length, 1);
    assert.equal(skipped.length, 4);
    assert.ok(skipped.every((s) => s.reason === 'DEPLOY_ALREADY_RUNNING'));
    await waitForStatus(started[0].id, ['SUCCESS', 'FAILED']);
  });

  it('lists deployments with filters, and pages logs with afterSeq', async () => {
    const res = await api(viewer, 'get', `/deployments?projectId=${fixtures.project.id}&status=FAILED`).expect(200);
    assert.ok(res.body.items.length >= 1);
    assert.ok(res.body.items.every((d) => d.status === 'FAILED'));
    assert.ok(res.body.items[0].target.project.name === 'E2E app');

    const id = res.body.items[0].id;
    const all = await api(viewer, 'get', `/deployments/${id}/logs`).expect(200);
    assert.equal(all.body.finished, true);
    const later = await api(viewer, 'get', `/deployments/${id}/logs?afterSeq=2`).expect(200);
    assert.deepEqual(
      later.body.lines.map((l) => l.seq),
      all.body.lines.filter((l) => l.seq > 2).map((l) => l.seq),
    );
  });

  it('refuses unknown targets and lets viewers neither deploy nor cancel', async () => {
    const res = await api(deployer, 'post', `/projects/${fixtures.project.id}/deploy`)
      .send({ targetIds: ['ckx9z0q8h0000abcd'] })
      .expect(422);
    assert.equal(res.body.error.code, 'UNKNOWN_TARGET');
    await api(viewer, 'post', `/projects/${fixtures.project.id}/deploy`).send({}).expect(403);
  });
});

describe('live logs over Socket.IO', () => {
  let server;
  let sockets;
  let url;

  before(async () => {
    server = http.createServer(app);
    sockets = createSocketServer(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await sockets.close();
    await new Promise((r) => server.close(r));
  });

  const connect = (cookie) =>
    ioClient(url, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, reconnection: false });

  it('refuses a connection without a session', async () => {
    const client = connect();
    const err = await new Promise((resolve) => client.on('connect_error', resolve));
    assert.equal(err.message, 'UNAUTHENTICATED');
    client.close();
  });

  it('exit check: log lines reach the browser in under 1 s', async () => {
    // How far the container's clock is from ours, measured over one round trip.
    const t0 = Date.now();
    const remoteNow = Number(await remote('echo $EPOCHREALTIME')) * 1000;
    const offset = remoteNow - (t0 + Date.now()) / 2;

    const client = connect(`access_token=${cookieFrom(viewer.res, 'access_token')}`);
    await new Promise((resolve, reject) => {
      client.on('connect', resolve);
      client.on('connect_error', reject);
    });

    const target = await fixtures.makeTarget({
      postDeploy: 'for i in 1 2 3 4 5; do echo "tick $EPOCHREALTIME"; sleep 0.4; done',
    });
    await deployQueue.pause(); // hold the job until we have joined the room
    const started = await deploy(target);
    const joined = await new Promise((r) => client.emit('deployment:join', { id: started.id }, r));
    assert.deepEqual(joined, { ok: true });

    const latencies = [];
    const seqs = [];
    client.on('deployment:logs', ({ lines }) => {
      const receivedAt = Date.now();
      for (const l of lines) {
        seqs.push(l.seq);
        const match = /^tick (\d+\.\d+)$/.exec(l.line);
        if (match) latencies.push(receivedAt - (Number(match[1]) * 1000 - offset));
      }
    });
    const finished = new Promise((resolve) =>
      client.on('deployment:status', (s) => s.status !== 'RUNNING' && resolve(s)),
    );
    await deployQueue.resume();

    const status = await finished;
    client.close();
    assert.equal(status.status, 'SUCCESS');
    assert.equal(latencies.length, 5);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'lines arrive in order');
    console.log(`  live log latency: max ${Math.max(...latencies).toFixed(0)} ms`);
    assert.ok(Math.max(...latencies) < 1000, `latencies ${latencies.map(Math.round)}`);
  });
});

it('every deploy left its target unlocked', async () => {
  await waitFor(async () => (await prisma.target.count({ where: { activeDeploymentId: { not: null } } })) === 0, {
    what: 'all locks released',
    timeout: 10_000,
  });
});
