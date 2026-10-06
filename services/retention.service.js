// Nightly clean-up: deploy log lines older than LOG_RETENTION_DAYS are deleted.
// Deployment records and the audit log are kept forever.
const prisma = require('../models/prisma');
const { logger } = require('../utils/logger');

const BATCH = 5000;

/** Deletes old log lines in batches, so the table is never locked for long. Returns the count. */
async function purgeOldLogs(days, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM \`DeploymentLog\` WHERE createdAt < ${cutoff} LIMIT ${BATCH}`;
    total += deleted;
    if (deleted < BATCH) break;
  }
  logger.info({ deleted: total, olderThan: cutoff.toISOString() }, 'old deploy logs deleted');
  return total;
}

module.exports = { purgeOldLogs };
