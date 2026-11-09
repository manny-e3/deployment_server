// PM2: runs the API and the deploy worker on the production server.
//   npm ci --omit=dev && npm run release
// Keep one instance of each: the worker's startup recovery assumes it is the only worker, and
// more than one API process would need the Socket.IO Redis adapter and sticky sessions.
const fs = require('fs');
const isSymlinkRelease = fs.existsSync('./current/index.js');

module.exports = {
  apps: [
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
    {
      name: 'portal-worker',
      script: isSymlinkRelease ? 'current/worker.js' : 'worker.js',
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
  ],
};
