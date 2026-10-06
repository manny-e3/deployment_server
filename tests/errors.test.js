require('./setup');
const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { Prisma } = require('@prisma/client');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { Conflict } = require('../utils/errors');
const errorHandler = require('../middlewares/errorHandler');

const app = express();
app.use(express.json());
app.get('/conflict', () => {
  throw new Conflict('DEPLOY_ALREADY_RUNNING', 'A deploy is already running on Production 1');
});
app.get('/unique', async () => {
  throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { target: ['email'] },
  });
});
app.get('/crash', async () => {
  throw new Error('db password is hunter2');
});
app.post('/echo', (req, res) => res.json(req.body));
app.use(errorHandler);

after(async () => {
  await prisma.user.deleteMany({ where: { email: 'dup@test.local' } });
  await closeConnections();
});

describe('error handler', () => {
  it('returns an AppError in the standard shape', async () => {
    const res = await request(app).get('/conflict').expect(409);
    assert.deepEqual(res.body, {
      error: {
        code: 'DEPLOY_ALREADY_RUNNING',
        message: 'A deploy is already running on Production 1',
      },
    });
  });

  it('maps Prisma P2002 to 409', async () => {
    const res = await request(app).get('/unique').expect(409);
    assert.equal(res.body.error.code, 'ALREADY_EXISTS');
    assert.deepEqual(res.body.error.details, { fields: ['email'] });
  });

  it('hides the message and stack of unknown errors', async () => {
    const res = await request(app).get('/crash').expect(500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(res.body).includes('hunter2'));
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"name":')
      .expect(400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });

  it('returns 404 in the standard shape for unknown routes', async () => {
    const res = await request(createApp()).get('/api/v1/nope').expect(404);
    assert.deepEqual(res.body.error, {
      code: 'ROUTE_NOT_FOUND',
      message: 'No route for GET /api/v1/nope',
    });
  });

  it('maps a real MySQL unique-constraint clash to 409', async () => {
    const user = { name: 'Dup', email: 'dup@test.local', passwordHash: 'x' };
    await prisma.user.deleteMany({ where: { email: user.email } });
    await prisma.user.create({ data: user });

    const err = await prisma.user.create({ data: user }).catch((e) => e);
    const mapped = errorHandler.toAppError(err);

    assert.equal(mapped.status, 409);
    assert.equal(mapped.code, 'ALREADY_EXISTS');
  });
});
