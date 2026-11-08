const assert = require('node:assert');
const { describe, it, before, beforeEach, after } = require('node:test');
const request = require('supertest');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const serverService = require('../services/server.service');
const { closeConnections } = require('../utils/connections');
const { resetDb, createUser, login } = require('./helpers');

const app = createApp();

describe('BYOS 1-liner setup flow', () => {
  let admin;

  before(resetDb);
  after(closeConnections);

  beforeEach(async () => {
    await resetDb();
    admin = await createUser('ADMIN');
  });

  it('auto-generates an ed25519 keypair and setup token on server creation', async () => {
    const server = await serverService.create(
      {
        name: 'Auto-Keyed Hetzner',
        host: '198.51.100.22',
        port: 22,
        authType: 'KEY',
        autoGenerateKey: true,
      },
      admin,
      '127.0.0.1'
    );

    assert.ok(server.id);
    assert.ok(server.publicKey.startsWith('ssh-ed25519 AAAAC3'));
    assert.ok(server.setupToken.startsWith('srv_'));
    assert.strictEqual(server.username, 'portalops');
    assert.ok(server.setupCommand.includes(`setup/${server.setupToken}.sh | bash`));

    // Verify GET /setup/:token.sh returns bash script containing the public key
    const scriptRes = await request(app)
      .get(`/setup/${server.setupToken}.sh`)
      .expect(200);

    assert.match(scriptRes.text, /#!\/bin\/bash/);
    assert.ok(scriptRes.text.includes(server.publicKey));
    assert.ok(scriptRes.text.includes(`user: '${server.username}'`));
    assert.ok(scriptRes.text.includes(`/setup/${server.setupToken}/complete`));

    // Verify GET /setup/:token/status is initially unconfigured
    const initialStatusRes = await request(app)
      .get(`/setup/${server.setupToken}/status`)
      .expect(200);

    assert.strictEqual(initialStatusRes.body.configured, false);
    assert.strictEqual(initialStatusRes.body.server.name, 'Auto-Keyed Hetzner');

    // Simulate VPS callback: POST /setup/:token/complete
    const callbackRes = await request(app)
      .post(`/setup/${server.setupToken}/complete`)
      .send({ hostname: 'hetzner-prod-1', os: 'Linux', kernel: '6.8.0' })
      .expect(200);

    assert.strictEqual(callbackRes.body.ok, true);

    // Verify status is now configured: true
    const updatedStatusRes = await request(app)
      .get(`/setup/${server.setupToken}/status`)
      .expect(200);

    assert.strictEqual(updatedStatusRes.body.configured, true);
    assert.ok(updatedStatusRes.body.completedAt);
  });
});

