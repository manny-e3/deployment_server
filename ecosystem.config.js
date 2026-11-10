// PM2: runs the API (and optionally the deploy worker) on the production server.
//   npm ci --omit=dev && npm run release
// On shared hosting (Hostinger, cPanel) without Redis, only portal-api should run
// to avoid background worker crash loops that exhaust process limits.
const fs = require('fs');
const isSymlinkRelease = fs.existsSync('./current/index.js');

const apps = [
  {
    name: 'portal-api',
    script: isSymlinkRelease ? 'current/index.js' : 'index.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '300M',
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    kill_timeout: 10_000,
    time: true,
  },
];

// Only start the background queue worker if explicitly enabled and Redis is configured
if (process.env.RUN_WORKER === 'true' && process.env.REDIS_URL && !process.env.REDIS_URL.includes('localhost') && !process.env.REDIS_URL.includes('.onrender.com') && !process.env.REDIS_URL.includes('red-')) {
  apps.push({
    name: 'portal-worker',
    script: isSymlinkRelease ? 'current/worker.js' : 'worker.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '300M',
    restart_delay: 10000,
    max_restarts: 5,
    min_uptime: '15s',
    kill_timeout: 10_000,
    time: true,
  });
}

module.exports = { apps };
