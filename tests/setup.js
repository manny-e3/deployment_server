// Required first by every test file. Tests never touch the development database:
// they use portal_test and Redis db 1.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'mysql://portal:portal@localhost:3307/portal_test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
  JWT_SECRET: 'a'.repeat(64),
  ENCRYPTION_KEY: 'b'.repeat(64),
});

// The sshd container from docker-compose.yml, standing in for a real target server.
const TEST_SSH = {
  host: process.env.TEST_SSH_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_SSH_PORT ?? 2222),
  username: 'deploy',
  password: 'deploy-test-only',
};

module.exports = { TEST_DATABASE_URL, TEST_SSH };
