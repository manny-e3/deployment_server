// Runs when the worker starts. A deploy that was running when the worker died, or is queued
// but has lost its job, is marked FAILED with WORKER_RESTARTED and its target lock released,
// so nothing stays "running" forever.
//
// This assumes one worker process. With several, each would fail the others' running deploys.
const prisma = require('../models/prisma');
const targetModel = require('../models/target.model');
const { publishStatus } = require('../utils/events');
const { logger } = require('../utils/logger');

const WAITING_STATES = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);

async function recoverStuckDeploys(queue) {
  const open = await prisma.deployment.findMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true, status: true, targetId: true, target: { select: { projectId: true } } },
  });

  const failed = [];
  for (const d of open) {
    if (d.status === 'QUEUED') {
      const job = await queue.getJob(d.id);
      if (job && WAITING_STATES.has(await job.getState())) continue; // still on its way
    }
    const finishedAt = new Date();
    await prisma.deployment.update({
      where: { id: d.id },
      data: { status: 'FAILED', error: 'WORKER_RESTARTED', finishedAt },
    });
    await targetModel.releaseLock(d.id);
    await publishStatus({
      id: d.id,
      status: 'FAILED',
      finishedAt,
      projectId: d.target.projectId,
      targetId: d.targetId,
    });
    failed.push(d.id);
  }

  // Locks pointing at a deploy that is already finished (should not happen, but never leave one).
  const { count: staleLocks } = await prisma.target.updateMany({
    where: {
      activeDeploymentId: { not: null },
      NOT: {
        activeDeploymentId: {
          in: (
            await prisma.deployment.findMany({
              where: { status: { in: ['QUEUED', 'RUNNING'] } },
              select: { id: true },
            })
          ).map((d) => d.id),
        },
      },
    },
    data: { activeDeploymentId: null },
  });

  if (failed.length || staleLocks) {
    logger.warn({ failed, staleLocks }, 'recovered deploys left behind by a previous worker');
  }
  return { failed, staleLocks };
}

module.exports = { recoverStuckDeploys };
