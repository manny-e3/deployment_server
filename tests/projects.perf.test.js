// Exit check for Week 4: the project list loads in under 200 ms with data at v1 scale
// (100 projects, 50 servers, 200 targets, 10,000 deploys).
require('./setup');
const { after, before, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const crypto = require('../utils/crypto');
const { SCALE, seedScale } = require('../prisma/seed-scale');
const { createUser, login, resetDb } = require('./helpers');

const app = createApp();
let session;

before(async () => {
  await resetDb();
  await seedScale(prisma, crypto);
  session = await login(app, await createUser('VIEWER'));
});

after(async () => {
  await resetDb();
  await closeConnections();
});

it('GET /projects?limit=100 answers in under 200 ms at v1 scale', async () => {
  const get = () => session.agent.get('/api/v1/projects?limit=100').expect(200);

  const first = await get(); // warm-up
  assert.equal(first.body.items.length, SCALE.projects);
  assert.ok(first.body.items.every((p) => p.targets.every((t) => t.lastDeploy)));

  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    await get();
    times.push(performance.now() - started);
  }
  const median = times.sort((a, b) => a - b)[2];
  console.log(`  project list median: ${median.toFixed(0)} ms`);
  assert.ok(median < 200, `median ${median.toFixed(0)} ms`);
});
