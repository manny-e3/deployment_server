require('./setup');
const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../index');
const prisma = require('../models/prisma');
const { closeConnections } = require('../utils/connections');
const { createUser, login, resetDb } = require('./helpers');

const app = createApp();

before(resetDb);
after(closeConnections);

const ID = 'ckx9z0q8h0000abcd'; // a well-formed id that doesn't exist

// Every route built so far, and who may call it.
const ROUTES = [
  { method: 'get', path: '/api/v1/auth/me', roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'patch', path: '/api/v1/auth/password', roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'get', path: '/api/v1/users', roles: ['ADMIN'] },
  { method: 'post', path: '/api/v1/users', roles: ['ADMIN'] },
  { method: 'get', path: `/api/v1/users/${ID}`, roles: ['ADMIN'] },
  { method: 'patch', path: `/api/v1/users/${ID}`, roles: ['ADMIN'] },
  { method: 'delete', path: `/api/v1/users/${ID}`, roles: ['ADMIN'] },
  { method: 'get', path: '/api/v1/servers', roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'get', path: `/api/v1/servers/${ID}`, roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'post', path: '/api/v1/servers', roles: ['ADMIN'] },
  { method: 'patch', path: `/api/v1/servers/${ID}`, roles: ['ADMIN'] },
  { method: 'delete', path: `/api/v1/servers/${ID}`, roles: ['ADMIN'] },
  { method: 'post', path: `/api/v1/servers/${ID}/test`, roles: ['ADMIN'] },
  { method: 'post', path: `/api/v1/servers/${ID}/reset-fingerprint`, roles: ['ADMIN'] },
  { method: 'get', path: '/api/v1/projects', roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'get', path: `/api/v1/projects/${ID}`, roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'post', path: '/api/v1/projects', roles: ['ADMIN'] },
  { method: 'patch', path: `/api/v1/projects/${ID}`, roles: ['ADMIN'] },
  { method: 'delete', path: `/api/v1/projects/${ID}`, roles: ['ADMIN'] },
  { method: 'post', path: `/api/v1/projects/${ID}/webhook-secret`, roles: ['ADMIN'] },
  { method: 'post', path: `/api/v1/projects/${ID}/targets`, roles: ['ADMIN'] },
  { method: 'patch', path: `/api/v1/projects/${ID}/targets/${ID}`, roles: ['ADMIN'] },
  { method: 'delete', path: `/api/v1/projects/${ID}/targets/${ID}`, roles: ['ADMIN'] },
  { method: 'get', path: `/api/v1/targets/${ID}/env`, roles: ['ADMIN'] },
  { method: 'put', path: `/api/v1/targets/${ID}/env`, roles: ['ADMIN'] },
  { method: 'post', path: `/api/v1/projects/${ID}/deploy`, roles: ['ADMIN', 'DEPLOYER'] },
  { method: 'get', path: '/api/v1/deployments', roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'get', path: `/api/v1/deployments/${ID}`, roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'get', path: `/api/v1/deployments/${ID}/logs`, roles: ['ADMIN', 'DEPLOYER', 'VIEWER'] },
  { method: 'post', path: `/api/v1/deployments/${ID}/cancel`, roles: ['ADMIN', 'DEPLOYER'] },
  { method: 'post', path: `/api/v1/deployments/${ID}/rollback`, roles: ['ADMIN', 'DEPLOYER'] },
  { method: 'get', path: '/api/v1/audit-logs', roles: ['ADMIN'] },
];

describe('permissions on every route', () => {
  const sessions = {};

  before(async () => {
    await resetDb();
    for (const role of ['ADMIN', 'DEPLOYER', 'VIEWER']) {
      sessions[role] = await login(app, await createUser(role));
    }
  });

  for (const route of ROUTES) {
    it(`${route.method.toUpperCase()} ${route.path}`, async () => {
      // No session: 401 (or 403 CSRF for writes, which comes first)
      const anon = await request(app)[route.method](route.path);
      assert.ok([401, 403].includes(anon.status), `anonymous got ${anon.status}`);

      for (const role of ['ADMIN', 'DEPLOYER', 'VIEWER']) {
        const { agent, csrf } = sessions[role];
        const res = await agent[route.method](route.path).set('X-CSRF-Token', csrf).send({});
        if (route.roles.includes(role)) {
          assert.notEqual(res.status, 403, `${role} should be allowed`);
          assert.notEqual(res.status, 401, `${role} should be logged in`);
        } else {
          assert.equal(res.status, 403, `${role} should get 403`);
          assert.equal(res.body.error.code, 'FORBIDDEN');
        }
      }
    });
  }
});

describe('users admin', () => {
  let admin;

  beforeEach(async () => {
    await resetDb();
    admin = await login(app, await createUser('ADMIN'));
  });

  const asAdmin = (method, path) => admin.agent[method](path).set('X-CSRF-Token', admin.csrf);

  it('creates a user with a temporary password that works once handed over', async () => {
    const res = await asAdmin('post', '/api/v1/users')
      .send({ name: 'Ada', email: 'Ada@Example.com', role: 'DEPLOYER' })
      .expect(201);

    assert.equal(res.body.user.email, 'ada@example.com');
    assert.equal(res.body.user.role, 'DEPLOYER');
    assert.equal(res.body.user.passwordHash, undefined);
    assert.equal(res.body.temporaryPassword.length, 16);

    await login(app, res.body.user, res.body.temporaryPassword);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'user.created' } });
    assert.equal(entry.entityId, res.body.user.id);
  });

  it('refuses a duplicate email with 409', async () => {
    const existing = await createUser('VIEWER');
    const res = await asAdmin('post', '/api/v1/users')
      .send({ name: 'Copy', email: existing.email })
      .expect(409);
    assert.equal(res.body.error.code, 'ALREADY_EXISTS');
  });

  it('lists users newest first with cursor pagination', async () => {
    for (let i = 0; i < 3; i += 1) await createUser('VIEWER');

    const first = await asAdmin('get', '/api/v1/users?limit=2').expect(200);
    assert.equal(first.body.items.length, 2);
    assert.ok(first.body.nextCursor);

    const second = await asAdmin('get', `/api/v1/users?limit=2&cursor=${first.body.nextCursor}`);
    assert.equal(second.body.items.length, 2); // 3 viewers + the admin = 4 users
    assert.equal(second.body.nextCursor, null);
    const ids = [...first.body.items, ...second.body.items].map((u) => u.id);
    assert.equal(new Set(ids).size, 4);
  });

  it('returns 404 for an unknown user', async () => {
    const res = await asAdmin('get', `/api/v1/users/${ID}`).expect(404);
    assert.equal(res.body.error.message, 'User not found');
  });

  it('refuses an empty update', async () => {
    const user = await createUser('VIEWER');
    await asAdmin('patch', `/api/v1/users/${user.id}`).send({}).expect(400);
  });

  it('a role change ends the user’s sessions at once and is audited', async () => {
    const user = await createUser('VIEWER');
    const session = await login(app, user);

    const res = await asAdmin('patch', `/api/v1/users/${user.id}`)
      .send({ role: 'DEPLOYER' })
      .expect(200);
    assert.equal(res.body.role, 'DEPLOYER');
    assert.equal(res.body.tokenVersion, undefined);

    await session.agent.get('/api/v1/auth/me').expect(401);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'user.updated' } });
    assert.deepEqual(entry.details, { role: { from: 'VIEWER', to: 'DEPLOYER' } });
  });

  it('a name change does not end the user’s sessions', async () => {
    const user = await createUser('VIEWER');
    const session = await login(app, user);
    await asAdmin('patch', `/api/v1/users/${user.id}`).send({ name: 'Renamed' }).expect(200);
    await session.agent.get('/api/v1/auth/me').expect(200);
  });

  it('exit check: a deactivated user is locked out straight away', async () => {
    const user = await createUser('DEPLOYER');
    const session = await login(app, user);
    await session.agent.get('/api/v1/auth/me').expect(200); // fills the 60 s cache

    await asAdmin('delete', `/api/v1/users/${user.id}`).expect(204);

    await session.agent.get('/api/v1/auth/me').expect(401);
    await session.agent
      .post('/api/v1/auth/refresh')
      .set('X-CSRF-Token', session.csrf)
      .expect(401);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'correct-horse-battery' })
      .expect(401);

    const row = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(row.isActive, false); // deactivated, not deleted
    const entry = await prisma.auditLog.findFirst({ where: { action: 'user.deactivated' } });
    assert.equal(entry.entityId, user.id);
  });

  it('an admin cannot deactivate themselves or change their own role', async () => {
    const me = await asAdmin('get', '/api/v1/auth/me').expect(200);
    for (const body of [{ isActive: false }, { role: 'VIEWER' }]) {
      const res = await asAdmin('patch', `/api/v1/users/${me.body.id}`).send(body).expect(422);
      assert.equal(res.body.error.code, 'CANNOT_CHANGE_OWN_ACCESS');
    }
    await asAdmin('delete', `/api/v1/users/${me.body.id}`).expect(422);
  });
});
