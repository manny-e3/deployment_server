const prisma = require('../models/prisma');
const { deployQueue } = require('../utils/queue');
const { redis } = require('../utils/redis');
const { logger } = require('../utils/logger');

const TIMEOUT_MS = 2000;

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS).unref(),
    ),
  ]);
}

// Failure reasons are logged, not returned: /health is public.
async function check(name, run) {
  const started = performance.now();
  try {
    const extra = await withTimeout(run());
    return { status: 'up', latencyMs: Math.round(performance.now() - started), ...extra };
  } catch (err) {
    logger.warn({ err, check: name }, 'health check failed');
    return { status: 'down' };
  }
}

async function getHealth() {
  const [database, redisCheck, queue] = await Promise.all([
    check('database', async () => {
      await prisma.$queryRaw`SELECT 1`;
      return {};
    }),
    check('redis', async () => {
      await redis.ping();
      return {};
    }),
    check('queue', () => deployQueue.getJobCounts('waiting', 'active', 'delayed', 'failed')),
  ]);

  const checks = { database, redis: redisCheck, queue };
  const down = Object.keys(checks).filter((name) => checks[name].status !== 'up');
  const healthy = down.length === 0;
  return {
    status: healthy ? 'ok' : 'degraded',
    message: healthy
      ? 'Deploy Portal API is running. Database, Redis and the deploy queue are all up.'
      : `Deploy Portal API is running, but these are down: ${down.join(', ')}.`,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  };
}

module.exports = { getHealth };
