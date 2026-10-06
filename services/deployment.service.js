// API side of deploys: start, list, read logs, cancel, roll back.
// The API never opens SSH for a deploy; it creates a QUEUED row and queues a job for the worker.
const prisma = require('../models/prisma');
const deploymentModel = require('../models/deployment.model');
const deploymentLogModel = require('../models/deploymentLog.model');
const projectModel = require('../models/project.model');
const targetModel = require('../models/target.model');
const audit = require('./audit.service');
const { cancelKey, publishStatus } = require('../utils/events');
const { deployQueue, enqueueDeploy } = require('../utils/queue');
const { redis } = require('../utils/redis');
const { logger } = require('../utils/logger');
const { BusinessRuleError, Conflict, NotFound } = require('../utils/errors');

const statusOf = (d, projectId) => ({ ...d, projectId, targetId: d.targetId });

/**
 * Starts a deploy on each chosen target (all of them when targetIds is omitted).
 * A target that already has a deploy queued or running is skipped, not queued twice.
 * Returns { started: [...], skipped: [{ targetId, reason }] }.
 */
async function start({ projectId, targetIds, branch, trigger = 'MANUAL', requestedSha = null, user, ip }) {
  const project = await projectModel.findByIdWithTargets(projectId);
  if (!project) throw new NotFound('Project');

  const chosen = targetIds
    ? project.targets.filter((t) => targetIds.includes(t.id))
    : project.targets;
  const unknown = (targetIds ?? []).filter((id) => !project.targets.some((t) => t.id === id));
  if (unknown.length) {
    throw new BusinessRuleError('UNKNOWN_TARGET', 'Some targets are not part of this project', {
      targetIds: unknown,
    });
  }
  if (chosen.length === 0) throw new BusinessRuleError('NO_TARGETS', 'This project has no targets yet');

  const started = [];
  const skipped = [];
  for (const target of chosen) {
    const deployBranch = branch ?? target.branch ?? project.defaultBranch;

    let deployment;
    try {
      deployment = await prisma.$transaction(async (tx) => {
        // Lock the target row first. A second click at the same moment waits here, then sees
        // the lock taken. (Inserting first would deadlock: the insert's foreign-key check takes a
        // shared lock on the same row in both requests.)
        const [row] = await tx.$queryRaw`
          SELECT activeDeploymentId FROM \`Target\` WHERE id = ${target.id} FOR UPDATE`;
        if (row?.activeDeploymentId) throw new Conflict('DEPLOY_ALREADY_RUNNING');

        const created = await tx.deployment.create({
          data: {
            targetId: target.id,
            triggeredById: user?.id ?? null,
            trigger,
            branch: deployBranch,
            requestedSha,
          },
          select: { id: true, number: true, targetId: true, status: true },
        });
        if (!(await targetModel.claimLock(target.id, created.id, tx))) {
          throw new Conflict('DEPLOY_ALREADY_RUNNING');
        }
        return created;
      });
    } catch (err) {
      if (err instanceof Conflict) {
        skipped.push({ targetId: target.id, reason: 'DEPLOY_ALREADY_RUNNING' });
        continue;
      }
      throw err;
    }

    try {
      await enqueueDeploy(deployment.id);
    } catch (err) {
      logger.error({ err, deploymentId: deployment.id }, 'queueing a deploy failed');
      await deploymentModel.update(deployment.id, {
        status: 'FAILED',
        error: 'QUEUE_UNAVAILABLE',
        finishedAt: new Date(),
      });
      await targetModel.releaseLock(deployment.id);
      skipped.push({ targetId: target.id, reason: 'QUEUE_UNAVAILABLE' });
      continue;
    }

    started.push(deployment);
    await audit.record({
      userId: user?.id,
      action: 'deploy.started',
      entity: 'deployment',
      entityId: deployment.id,
      details: { projectId, targetId: target.id, number: deployment.number, branch: deployBranch, trigger, requestedSha },
      ip,
    });
    await publishStatus(statusOf(deployment, projectId));
  }
  return { started, skipped };
}

const list = (query) => deploymentModel.list(query);

async function get(id) {
  const deployment = await deploymentModel.findById(id);
  if (!deployment) throw new NotFound('Deployment');
  return deployment;
}

/** Log lines after afterSeq, for the first load and for filling a gap after a reconnect. */
async function logs(id, { afterSeq, limit }) {
  const deployment = await get(id);
  const rows = await deploymentLogModel.listAfter(id, afterSeq, limit);
  return {
    lines: rows.map((r) => ({ seq: r.seq, stream: r.stream, line: r.line, at: r.createdAt })),
    lastSeq: rows.at(-1)?.seq ?? afterSeq,
    finished: !['QUEUED', 'RUNNING'].includes(deployment.status),
  };
}

/**
 * A queued deploy is cancelled at once. A running one gets a cancel signal the worker checks
 * every second; the answer is then { status: 'CANCELLING' }.
 */
async function cancel(id, user, ip) {
  const deployment = await get(id);
  const projectId = deployment.target.project.id;

  if (deployment.status === 'QUEUED' && (await deploymentModel.cancelIfQueued(id))) {
    await targetModel.releaseLock(id);
    await deployQueue.remove(id).catch(() => {});
    await audit.record({ userId: user.id, action: 'deploy.cancelled', entity: 'deployment', entityId: id, ip });
    await publishStatus(statusOf({ ...deployment, status: 'CANCELLED', finishedAt: new Date() }, projectId));
    return { status: 'CANCELLED' };
  }

  // Either RUNNING, or the worker took it between our read and our update.
  const fresh = await get(id);
  if (fresh.status === 'RUNNING' || fresh.status === 'QUEUED') {
    await redis.set(cancelKey(id), user.id, 'EX', 3600);
    await audit.record({
      userId: user.id,
      action: 'deploy.cancel_requested',
      entity: 'deployment',
      entityId: id,
      ip,
    });
    return { status: 'CANCELLING' };
  }
  throw new BusinessRuleError('NOT_CANCELLABLE', `This deploy has already finished (${fresh.status})`);
}

/** Deploys the exact commit of an earlier successful deploy again, as a new deployment. */
async function rollback(id, user, ip) {
  const from = await get(id);
  if (from.status !== 'SUCCESS' || !from.commitSha) {
    throw new BusinessRuleError('NOT_ROLLBACKABLE', 'Only a successful deploy with a known commit can be rolled back to');
  }
  const { started, skipped } = await start({
    projectId: from.target.project.id,
    targetIds: [from.targetId],
    branch: from.branch,
    trigger: 'ROLLBACK',
    requestedSha: from.commitSha,
    user,
    ip,
  });
  if (skipped.length) {
    throw new Conflict('DEPLOY_ALREADY_RUNNING', `A deploy is already running on ${from.target.name}`);
  }
  await audit.record({
    userId: user.id,
    action: 'deploy.rollback',
    entity: 'deployment',
    entityId: started[0].id,
    details: { fromDeploymentId: id, commitSha: from.commitSha },
    ip,
  });
  return started[0];
}

module.exports = { start, list, get, logs, cancel, rollback };
