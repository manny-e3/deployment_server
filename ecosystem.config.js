// PM2: runs the API and the deploy worker on the production server.
//   npm ci --omit=dev && npm run release
// Keep one instance of each: the worker's startup recovery assumes it is the only worker, and
// more than one API process would need the Socket.IO Redis adapter and sticky sessions.
module.exports = {
  apps: [
    {
      name: 'portal-api',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '500M',
      kill_timeout: 10_000,
      time: true,
    },
    {
      name: 'portal-worker',
      script: 'worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '500M',
      kill_timeout: 10_000,
      time: true,
    },
  ],
};
