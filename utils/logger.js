const path = require('node:path');
const pino = require('pino');
const { env } = require('./env');

// Field names replaced with [REDACTED] before anything is written.
const redactPaths = [
  'password',
  '*.password',
  'currentPassword',
  '*.currentPassword',
  'newPassword',
  '*.newPassword',
  'secret',
  '*.secret',
  'privateKey',
  '*.privateKey',
  'passphrase',
  '*.passphrase',
  'value',
  '*.value',
  'cookies',
  '*.cookies',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

// pino-pretty is a dev dependency; production installs and the Docker image don't have it.
const hasPretty = (() => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

// Logs go to the console and to logs/app.log. Tests log nothing.
function destination() {
  if (env.NODE_ENV === 'test') return undefined;
  try {
    const consoleTarget =
      env.NODE_ENV === 'development' && hasPretty
        ? {
            target: 'pino-pretty',
            options: { destination: 1, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          }
        : { target: 'pino/file', options: { destination: 1 } };
    const fileTarget = {
      target: 'pino/file',
      options: { destination: path.join(__dirname, '..', 'logs', 'app.log'), mkdir: true },
    };
    return pino.transport({
      targets: [consoleTarget, fileTarget].map((t) => ({ ...t, level: env.LOG_LEVEL })),
    });
  } catch (err) {
    // Fallback for shared hosting / thread-limited environments (EAGAIN on worker_threads)
    return pino.destination(1);
  }
}

const logger = pino(
  {
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
  },
  destination(),
);

module.exports = { logger, redactPaths };
