require('./setup');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { encrypt } = require('../utils/crypto');
const { channels } = require('../utils/events');
const { LogStream } = require('../utils/logStream');
const { createRedisConnection } = require('../utils/redis');
const { resetDb } = require('./helpers');

let deploymentId;
const subscriber = createRedisConnection('test-sub');
const published = [];

before(async () => {
  await resetDb();
  const server = await prisma.server.create({
    data: { name: 's', host: 'h', username: 'u', authType: 'PASSWORD', secretEnc: encrypt('x') },
  });
  const project = await prisma.project.create({
    data: { name: 'p', repoUrl: 'git@x:y.git', webhookSecretEnc: encrypt('x') },
  });
  const target = await prisma.target.create({
    data: { projectId: project.id, serverId: server.id, name: 't', path: '/a', preDeploy: '', postDeploy: '' },
  });
  subscriber.on('message', (_c, message) => published.push(JSON.parse(message)));
  const newDeployment = async () =>
    (await prisma.deployment.create({ data: { targetId: target.id, trigger: 'MANUAL', branch: 'main' } })).id;
  deploymentId = newDeployment;
});

after(async () => {
  await subscriber.quit();
  await resetDb();
  await closeConnections();
});

const rows = (id) => prisma.deploymentLog.findMany({ where: { deploymentId: id }, orderBy: { seq: 'asc' } });

describe('LogStream', () => {
  it('numbers lines, joins partial chunks, and saves and publishes them in batches of 100', async () => {
    const id = await deploymentId();
    await subscriber.subscribe(channels.logs(id));
    published.length = 0;

    const log = new LogStream(id);
    log.write('STDOUT', 'hel');
    log.write('STDOUT', 'lo\nwor');
    log.write('STDERR', 'oops\r\n');
    for (let i = 0; i < 250; i += 1) log.write('STDOUT', `\nline ${i}`);
    await log.close();

    const saved = await rows(id);
    assert.equal(saved.length, 253); // hello, oops, wor, line 0 ... line 249
    assert.deepEqual(saved.map((r) => r.seq), Array.from({ length: 253 }, (_, i) => i + 1));
    assert.deepEqual(
      saved.slice(0, 3).map((r) => [r.stream, r.line]),
      [
        ['STDOUT', 'hello'],
        ['STDERR', 'oops'],
        ['STDOUT', 'wor'],
      ],
    );

    await new Promise((r) => setTimeout(r, 100));
    assert.ok(published.every((m) => m.id === id && m.lines.length <= 100));
    assert.equal(published.flatMap((m) => m.lines).length, 253);
  });

  it('cuts lines at 4 KB and stops at the line limit with one notice', async () => {
    const id = await deploymentId();
    const log = new LogStream(id, { maxLines: 5 });
    log.write('STDOUT', `${'x'.repeat(5000)}\n`);
    for (let i = 0; i < 20; i += 1) log.write('STDOUT', `n${i}\n`);
    await log.close();

    const saved = await rows(id);
    assert.equal(saved.length, 6);
    assert.ok(saved[0].line.startsWith('x'.repeat(4096)));
    assert.match(saved[0].line, /cut at 4 KB/);
    assert.equal(saved[5].stream, 'SYSTEM');
    assert.match(saved[5].line, /Log cut at 5 lines/);
  });

  it('lets a filter hide or rewrite lines', async () => {
    const id = await deploymentId();
    const log = new LogStream(id, {
      filter: (stream, line) =>
        line.startsWith('__HIDE') ? null : line === 'step' ? { stream: 'SYSTEM', line: 'Step!' } : { stream, line },
    });
    log.write('STDOUT', '__HIDE me\nstep\nkeep\n');
    log.system('From the portal');
    await log.close();

    assert.deepEqual(
      (await rows(id)).map((r) => [r.stream, r.line]),
      [
        ['SYSTEM', 'Step!'],
        ['STDOUT', 'keep'],
        ['SYSTEM', 'From the portal'],
      ],
    );
  });
});
