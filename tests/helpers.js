// Shared helpers for tests that need users and logged-in sessions.
const argon2 = require('argon2');
const request = require('supertest');
const prisma = require('../models/prisma');
const { redis } = require('../utils/redis');

const PASSWORD = 'correct-horse-battery';
let counter = 0;

/** Empties the auth tables and test Redis (db 1), so each test file starts clean. */
async function resetDb() {
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.target.deleteMany(); // also removes their env vars and deployments
  await prisma.project.deleteMany();
  await prisma.server.deleteMany();
  await prisma.user.deleteMany();
  await redis.flushdb();
}

async function createUser(role = 'VIEWER', overrides = {}) {
  counter += 1;
  return prisma.user.create({
    data: {
      name: `${role} ${counter}`,
      email: `${role.toLowerCase()}${counter}@test.local`,
      passwordHash: await argon2.hash(overrides.password ?? PASSWORD, { type: argon2.argon2id }),
      role,
      ...(overrides.isActive !== undefined && { isActive: overrides.isActive }),
    },
  });
}

/** Value of one cookie from a response's Set-Cookie headers. */
function cookieFrom(res, name) {
  const header = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? decodeURIComponent(header.split(';')[0].slice(name.length + 1)) : undefined;
}

/** Logs a user in. Returns a cookie-keeping agent and the CSRF token to send on writes. */
async function login(app, user, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password })
    .expect(200);
  return { agent, csrf: cookieFrom(res, 'csrf_token'), res };
}

/** Fails if any key anywhere in the response body ends in "Enc" (an encrypted column). */
function assertNoEncFields(body, path = 'body') {
  if (Array.isArray(body)) return body.forEach((item, i) => assertNoEncFields(item, `${path}[${i}]`));
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (key.endsWith('Enc')) throw new Error(`Response leaks encrypted field ${path}.${key}`);
      assertNoEncFields(value, `${path}.${key}`);
    }
  }
}

module.exports = { PASSWORD, resetDb, createUser, cookieFrom, login, assertNoEncFields };
