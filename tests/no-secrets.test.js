// Exit check: no API response contains an encrypted field or a stored secret.
// Fills every table with known secrets, then reads every GET endpoint as an admin.
require('./setup');
const { after, before, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { PASSWORD, assertNoEncFields, createUser, login, resetDb } = require('./helpers');

const app = createApp();
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures', 'test_ed25519'), 'utf8');
const SECRETS = {
  privateKey: privateKey.split('\n')[1], // a line from the middle of the key
  passphrase: 'passphrase-1234567',
  serverPassword: 'server-password-7654321',
  envValue: 'env-value-s3cr3t-9999',
  userPassword: PASSWORD,
};

let admin;
const ids = {};

before(async () => {
  await resetDb();
  const adminUser = await createUser('ADMIN');
  admin = await login(app, adminUser);
  ids.user = adminUser.id;
  const as = (method, url) => admin.agent[method](`/api/v1${url}`).set('X-CSRF-Token', admin.csrf);

  const keyServer = await as('post', '/servers').send({
    name: 'Key server',
    host: '10.0.0.1',
    username: 'deploy',
    authType: 'KEY',
    secret: privateKey,
    passphrase: SECRETS.passphrase,
  });
  await as('post', '/servers').send({
    name: 'Password server',
    host: '10.0.0.2',
    username: 'deploy',
    authType: 'PASSWORD',
    secret: SECRETS.serverPassword,
  });
  ids.server = keyServer.body.id;

  const project = await as('post', '/projects').send({ name: 'Shop', repoUrl: 'git@github.com:acme/shop.git' });
  ids.project = project.body.id;
  SECRETS.webhookSecret = project.body.webhookSecret; // returned once, on create

  const target = await as('post', `/projects/${ids.project}/targets`).send({
    name: 'Production',
    serverId: ids.server,
    path: '/var/www/shop',
  });
  ids.target = target.body.id;
  await as('put', `/targets/${ids.target}/env`).send({ vars: { API_KEY: SECRETS.envValue } });

  const d = await prisma.deployment.create({
    data: { targetId: ids.target, trigger: 'MANUAL', branch: 'main', status: 'SUCCESS' },
  });
  ids.deployment = d.id;
  await prisma.deploymentLog.create({
    data: { deploymentId: d.id, seq: 1, stream: 'SYSTEM', line: 'Deploying commit abc' },
  });
});

after(async () => {
  await resetDb();
  await closeConnections();
});

it('exit check: no GET endpoint returns an encrypted field or a stored secret', async () => {
  const urls = [
    '/auth/me',
    '/users',
    `/users/${ids.user}`,
    '/servers',
    `/servers/${ids.server}`,
    '/projects',
    `/projects/${ids.project}`,
    `/targets/${ids.target}/env`,
    '/deployments',
    `/deployments/${ids.deployment}`,
    `/deployments/${ids.deployment}/logs`,
    '/audit-logs?limit=100',
  ];

  for (const url of urls) {
    const res = await admin.agent.get(`/api/v1${url}`).expect(200);
    assertNoEncFields(res.body);
    const text = JSON.stringify(res.body);
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.ok(!text.includes(value), `${url} leaks ${name}`);
    }
    for (const field of ['passwordHash', 'tokenVersion', 'tokenHash']) {
      assert.ok(!text.includes(`"${field}"`), `${url} leaks ${field}`);
    }
  }
});

it('the audit log never stores a secret either', async () => {
  const text = JSON.stringify(
    (await prisma.auditLog.findMany()).map((e) => ({ ...e, id: String(e.id) })),
  );
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `audit log holds ${name}`);
  }
});
