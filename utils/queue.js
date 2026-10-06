const { Queue } = require('bullmq');
const { createRedisConnection } = require('./redis');

const DEPLOY_QUEUE = 'deploys';
const MAINTENANCE_QUEUE = 'maintenance';

// BullMQ does not close a connection it was given, so keep them to close on shutdown.
const queueConnection = createRedisConnection('queue');
const deployQueue = new Queue(DEPLOY_QUEUE, { connection: queueConnection });
const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: queueConnection });

/**
 * Queues one deploy. jobId = deployment id, so it can never be queued twice, and attempts: 1,
 * because a failed deploy is never retried automatically.
 */
const enqueueDeploy = (deploymentId) =>
  deployQueue.add(
    'deploy',
    { deploymentId },
    { jobId: deploymentId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 },
  );

/** Schedules the nightly log clean-up at 03:00 UTC (safe to call on every start). */
const scheduleMaintenance = () =>
  maintenanceQueue.upsertJobScheduler(
    'log-retention',
    { pattern: '0 3 * * *', tz: 'UTC' },
    { name: 'log-retention', opts: { removeOnComplete: 30, removeOnFail: 30 } },
  );

module.exports = {
  DEPLOY_QUEUE,
  MAINTENANCE_QUEUE,
  deployQueue,
  maintenanceQueue,
  queueConnection,
  enqueueDeploy,
  scheduleMaintenance,
};
