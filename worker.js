// The deploy worker runs as its own process: `npm run worker`.
// It takes jobs from the BullMQ "deploys" queue and runs them over SSH, and runs the nightly
// log clean-up from the "maintenance" queue.
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

async function main() {
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

const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  // Running deploys are not waited for; the next start marks them WORKER_RESTARTED.
  await Promise.allSettled(workers.map((w) => w.close(true)));
  await Promise.allSettled(connections.map((c) => c.quit()));
  await closeConnections();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
