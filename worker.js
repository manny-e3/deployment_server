// The deploy worker runs as its own process: `npm run worker`.
// It takes jobs from the BullMQ "deploys" queue and runs them over SSH, and runs the nightly
// log clean-up from the "maintenance" queue.
//
// On hosts without background workers (Render's free plan), set WORKER_IN_PROCESS=true and the
// API starts it inside its own process instead (see index.js).
const { Worker } = require('bullmq');
const { env } = require('./utils/env');
const { logger: baseLogger } = require('./utils/logger');
const prisma = require('./models/prisma');
const { closeConnections } = require('./utils/connections');
const {
  DEPLOY_QUEUE,
  MAINTENANCE_QUEUE,
  deployQueue,
  scheduleMaintenance,
} = require('./utils/queue');
const { createRedisConnection, redis } = require('./utils/redis');
const slots = require('./utils/slots');
const { recoverStuckDeploys } = require('./services/recovery.service');
const { purgeOldLogs } = require('./services/retention.service');
const { runDeployment } = require('./jobs/deploy.job');

const logger = baseLogger.child({ process: 'worker' });
const workers = [];
const connections = [];

async function startWorker() {
  await prisma.$queryRaw`SELECT 1`;
  await redis.ping();

  // Before taking any job: fail whatever a previous worker left running, free its slots.
  await recoverStuckDeploys(deployQueue);
  await slots.clearAll();

  const deployConnection = createRedisConnection('worker-deploys');
  const deploys = new Worker(DEPLOY_QUEUE, (job) => runDeployment(job.data.deploymentId), {
    connection: deployConnection,
    concurrency: env.WORKER_CONCURRENCY,
    // A job interrupted by a crash is never re-run; recovery marks it failed instead.
    maxStalledCount: 0,
  });
  deploys.on('failed', (job, err) =>
    logger.error({ err, deploymentId: job?.data.deploymentId }, 'deploy job crashed'),
  );

  const maintenanceConnection = createRedisConnection('worker-maintenance');
  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === 'log-retention') return { deleted: await purgeOldLogs(env.LOG_RETENTION_DAYS) };
      return null;
    },
    { connection: maintenanceConnection, concurrency: 1 },
  );
  await scheduleMaintenance();

  workers.push(deploys, maintenance);
  connections.push(deployConnection, maintenanceConnection);
  logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker ready');
}

/** Stops taking jobs. Running deploys are not waited for; the next start marks them WORKER_RESTARTED. */
async function stopWorker() {
  await Promise.allSettled(workers.map((w) => w.close(true)));
  await Promise.allSettled(connections.map((c) => c.quit()));
}

// `node worker.js` runs the worker as its own process.
if (require.main === module) {
  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    await stopWorker();
    await closeConnections();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  startWorker().catch((err) => {
    logger.fatal({ err }, 'worker failed to start');
    process.exit(1);
  });
}

module.exports = { startWorker, stopWorker };
