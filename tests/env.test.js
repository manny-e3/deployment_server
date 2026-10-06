require('./setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv } = require('../utils/env');

const valid = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'mysql://u:p@localhost:3306/portal',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'c'.repeat(64),
  ENCRYPTION_KEY: 'd'.repeat(64),
};

describe('env config', () => {
  it('applies defaults to a minimal valid set', () => {
    const env = parseEnv({ ...valid, SENTRY_DSN: '' });
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.PORT, 4000);
    assert.equal(env.ACCESS_TOKEN_TTL, '15m');
    assert.equal(env.WORKER_CONCURRENCY, 5);
    assert.equal(env.SENTRY_DSN, undefined);
  });

  it('names every missing or malformed variable in one error', () => {
    assert.throws(
      () =>
        parseEnv({
          ...valid,
          JWT_SECRET: undefined,
          DATABASE_URL: 'postgres://x',
          ACCESS_TOKEN_TTL: '15 minutes',
        }),
      (err) =>
        /JWT_SECRET/.test(err.message) &&
        /DATABASE_URL: must be a mysql:\/\/ URL/.test(err.message) &&
        /ACCESS_TOKEN_TTL/.test(err.message),
    );
  });
});
