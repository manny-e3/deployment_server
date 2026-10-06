require('./setup');
const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../index');
const { closeConnections } = require('../utils/connections');

const app = createApp();

after(closeConnections);

describe('GET /api/v1/health', () => {
  it('reports MySQL, Redis and the deploy queue as up', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);

    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.checks.database.status, 'up');
    assert.equal(res.body.checks.redis.status, 'up');
    assert.equal(res.body.checks.queue.status, 'up');
    assert.equal(typeof res.body.checks.queue.waiting, 'number');
  });

  it('reuses a well-formed X-Request-Id', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123');
    assert.equal(res.headers['x-request-id'], 'abc-123');
  });

  it('replaces an unsafe X-Request-Id with a new one', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id <script>');
    assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  });
});
