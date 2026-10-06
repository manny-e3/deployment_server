require('./setup');
const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { PASSWORD, cookieFrom, createUser, login, resetDb } = require('./helpers');

const app = createApp();

before(resetDb);
after(closeConnections);

describe('POST /auth/login', () => {
  beforeEach(resetDb);

  it('sets httpOnly session cookies and a readable CSRF cookie', async () => {
    const user = await createUser('VIEWER');
    const { res } = await login(app, user);

    const cookies = res.headers['set-cookie'].join('\n');
    assert.match(cookies, /access_token=[^;]+;.*HttpOnly/);
    assert.match(cookies, /refresh_token=[^;]+;.*HttpOnly/);
    assert.match(cookies, /SameSite=Strict/);
    const csrfLine = res.headers['set-cookie'].find((c) => c.startsWith('csrf_token='));
    assert.doesNotMatch(csrfLine, /HttpOnly/);

    assert.equal(res.body.email, user.email);
    assert.equal(res.body.passwordHash, undefined);
    assert.equal(res.body.tokenVersion, undefined);
  });

  it('accepts the email in any letter case', async () => {
    const user = await createUser('VIEWER');
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email.toUpperCase(), password: PASSWORD })
      .expect(200);
  });

  it('gives the same answer for a wrong password, an unknown email and an inactive user', async () => {
    const user = await createUser('VIEWER');
    const inactive = await createUser('VIEWER', { isActive: false });
    const attempts = [
      { email: user.email, password: 'wrong-password-123' },
      { email: 'nobody@test.local', password: PASSWORD },
      { email: inactive.email, password: PASSWORD },
    ];
    for (const body of attempts) {
      const res = await request(app).post('/api/v1/auth/login').send(body).expect(401);
      assert.deepEqual(res.body.error, {
        code: 'INVALID_CREDENTIALS',
        message: 'The email or password is wrong',
      });
    }
    const failures = await prisma.auditLog.count({ where: { action: 'auth.login_failed' } });
    assert.equal(failures, 3);
  });

  it('allows 5 attempts per 15 minutes per IP and email, then answers 429', async () => {
    const user = await createUser('VIEWER');
    const attempt = () =>
      request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'nope-nope-nope' });

    for (let i = 0; i < 5; i += 1) await attempt().expect(401);
    const res = await attempt().expect(429);
    assert.equal(res.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(res.headers['retry-after']) > 0);
  });

  it('writes an auth.login audit entry', async () => {
    const user = await createUser('VIEWER');
    await login(app, user);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'auth.login' } });
    assert.equal(entry.userId, user.id);
  });
});

describe('sessions', () => {
  beforeEach(resetDb);

  it('GET /auth/me needs a session', async () => {
    const res = await request(app).get('/api/v1/auth/me').expect(401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('GET /auth/me returns the logged-in user', async () => {
    const user = await createUser('DEPLOYER');
    const { agent } = await login(app, user);
    const res = await agent.get('/api/v1/auth/me').expect(200);
    assert.equal(res.body.id, user.id);
    assert.equal(res.body.role, 'DEPLOYER');
  });

  it('refuses a write request without the X-CSRF-Token header', async () => {
    const user = await createUser('VIEWER');
    const { agent } = await login(app, user);
    const res = await agent.post('/api/v1/auth/logout').expect(403);
    assert.equal(res.body.error.code, 'CSRF_FAILED');
  });

  it('refresh rotates the token; reusing the old one ends every session', async () => {
    const user = await createUser('VIEWER');
    const { agent, csrf, res: loginRes } = await login(app, user);
    const oldRefresh = cookieFrom(loginRes, 'refresh_token');

    const refreshed = await agent
      .post('/api/v1/auth/refresh')
      .set('X-CSRF-Token', csrf)
      .expect(200);
    assert.notEqual(cookieFrom(refreshed, 'refresh_token'), oldRefresh);
    const newCsrf = cookieFrom(refreshed, 'csrf_token');

    // Someone replays the old refresh token...
    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${oldRefresh}`, 'csrf_token=x'])
      .set('X-CSRF-Token', 'x')
      .expect(401);

    // ...so the real user's newer session is ended too.
    await agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', newCsrf).expect(401);
    await agent.get('/api/v1/auth/me').expect(401);
    // Both the replay and the real user's now-revoked token are logged as reuse.
    const reuse = await prisma.auditLog.count({ where: { action: 'auth.refresh_reuse' } });
    assert.equal(reuse, 2);
  });

  it('logout revokes the refresh token and clears the cookies', async () => {
    const user = await createUser('VIEWER');
    const { agent, csrf, res: loginRes } = await login(app, user);
    const refresh = cookieFrom(loginRes, 'refresh_token');

    const res = await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf).expect(204);
    assert.match(res.headers['set-cookie'].join('\n'), /refresh_token=;/);

    await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${refresh}`, 'csrf_token=x'])
      .set('X-CSRF-Token', 'x')
      .expect(401);
  });
});

describe('PATCH /auth/password', () => {
  beforeEach(resetDb);

  it('refuses a wrong current password', async () => {
    const user = await createUser('VIEWER');
    const { agent, csrf } = await login(app, user);
    const res = await agent
      .patch('/api/v1/auth/password')
      .set('X-CSRF-Token', csrf)
      .send({ currentPassword: 'not-my-password', newPassword: 'a-brand-new-password' })
      .expect(400);
    assert.equal(res.body.error.code, 'INVALID_CURRENT_PASSWORD');
  });

  it('refuses a new password shorter than 12 characters', async () => {
    const user = await createUser('VIEWER');
    const { agent, csrf } = await login(app, user);
    const res = await agent
      .patch('/api/v1/auth/password')
      .set('X-CSRF-Token', csrf)
      .send({ currentPassword: PASSWORD, newPassword: 'short' })
      .expect(400);
    assert.equal(res.body.error.details.fields[0].field, 'body.newPassword');
  });

  it('changes the password, keeps this session and ends the others', async () => {
    const user = await createUser('VIEWER');
    const laptop = await login(app, user);
    const phone = await login(app, user);

    await laptop.agent
      .patch('/api/v1/auth/password')
      .set('X-CSRF-Token', laptop.csrf)
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(204);

    await laptop.agent.get('/api/v1/auth/me').expect(200);
    await phone.agent.get('/api/v1/auth/me').expect(401);
    await login(app, user, 'a-brand-new-password');
  });
});
