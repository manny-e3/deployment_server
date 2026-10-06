// Runs before `npm test`: brings the test database up to the latest migration.
const { execSync } = require('node:child_process');
const path = require('node:path');
const { TEST_DATABASE_URL } = require('./setup');

execSync('npx prisma migrate deploy', {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  stdio: 'inherit',
});
