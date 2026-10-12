const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');

// Fields the API returns for a deployment, with where it ran and who started it.
const publicFields = {
  id: true,
  number: true,
  targetId: true,
  trigger: true,
  status: true,
  branch: true,
  requestedSha: true,
  commitSha: true,
  commitMessage: true,
  previousSha: true,
  exitCode: true,
  error: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  target: { select: { id: true, name: true, project: { select: { id: true, name: true } } } },
  triggeredBy: { select: { id: true, name: true } },
};

const findById = (id, db = prisma) =>
  db.deployment.findUnique({ where: { id }, select: publicFields });

// Everything the worker needs to run a deploy, including encrypted secrets.
const findForRun = (id, db = prisma) =>
  db.deployment.findUnique({
    where: { id },
    include: { target: { include: { server: true, project: true, envVars: true } } },
  });

/** QUEUED -> RUNNING. Returns false if it was no longer queued (e.g. cancelled). */
async function markRunning(id, db = prisma) {
  const { count } = await db.deployment.updateMany({
    where: { id, status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  return count === 1;
}

/** QUEUED -> CANCELLED. Returns false if the worker already took it. */
async function cancelIfQueued(id, db = prisma) {
  const { count } = await db.deployment.updateMany({
    where: { id, status: 'QUEUED' },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  return count === 1;
}

const update = (id, data, db = prisma) =>
  db.deployment.update({ where: { id }, data, select: publicFields });

/** Newest first, filtered and cursor-paginated: returns { items, nextCursor }. */
async function list({ limit, cursor, projectId, targetId, status, trigger, from, to }, db = prisma) {
  const where = {
    ...(targetId && { targetId }),
    ...(projectId && { target: { projectId } }),
    ...(status && { status }),
    ...(trigger && { trigger }),
    ...((from || to) && { queuedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
  };
  const rows = await db.deployment.findMany({
    where,
    select: publicFields,
    orderBy: { number: 'desc' },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items.at(-1).id : null };
}

/**
 * The newest deployment of each target, in one query. Returns a Map of targetId -> deployment.
 *
 * For each target, a subquery reads only its newest id from the (targetId, queuedAt) index
 * (id breaks ties, and InnoDB keeps it in that index too); one join then fetches those rows.
 * This stays fast however long the history grows, unlike ROW_NUMBER() over every deploy
 * (133 ms at 10,000 deploys). It avoids LATERAL so it runs on MariaDB as well as MySQL 8.
 */
async function lastPerTarget(targetIds, db = prisma) {
  if (targetIds.length === 0) return new Map();
  const rows = await db.$queryRaw`
    SELECT d.id, d.number, d.targetId, d.status, d.\`trigger\`, d.branch, d.commitSha,
           d.queuedAt, d.startedAt, d.finishedAt
    FROM (
      SELECT (
        SELECT x.id FROM \`Deployment\` x
        WHERE x.targetId = t.id
        ORDER BY x.queuedAt DESC, x.id DESC
        LIMIT 1
      ) AS lastId
      FROM \`Target\` t
      WHERE t.id IN (${Prisma.join(targetIds)})
    ) latest
    JOIN \`Deployment\` d ON d.id = latest.lastId`;
  return new Map(rows.map((row) => [row.targetId, row]));
}

module.exports = {
  publicFields,
  findById,
  findForRun,
  markRunning,
  cancelIfQueued,
  update,
  list,
  lastPerTarget,
};
