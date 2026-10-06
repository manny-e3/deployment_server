const prisma = require('./prisma');

// Fields the API may return. webhookSecretEnc is never selected here.
const publicFields = {
  id: true,
  name: true,
  repoUrl: true,
  defaultBranch: true,
  autoDeploy: true,
  createdAt: true,
  updatedAt: true,
};

// Targets in the project list: a summary, without the commands.
const targetSummary = {
  id: true,
  name: true,
  path: true,
  branch: true,
  activeDeploymentId: true,
  server: { select: { id: true, name: true } },
};

const findById = (id, db = prisma) => db.project.findUnique({ where: { id }, select: publicFields });

const findByIdWithTargets = (id, db = prisma) =>
  db.project.findUnique({
    where: { id },
    select: {
      ...publicFields,
      targets: {
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          path: true,
          branch: true,
          preDeploy: true,
          postDeploy: true,
          healthCheckUrl: true,
          activeDeploymentId: true,
          createdAt: true,
          server: { select: { id: true, name: true, host: true } },
        },
      },
    },
  });

/** Sorted by name, cursor-paginated, each with its targets: returns { items, nextCursor }. */
async function list({ limit, cursor }, db = prisma) {
  const rows = await db.project.findMany({
    select: { ...publicFields, targets: { select: targetSummary, orderBy: { name: 'asc' } } },
    orderBy: { name: 'asc' },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items.at(-1).id : null };
}

const create = (data, db = prisma) => db.project.create({ data, select: publicFields });

const update = (id, data, db = prisma) =>
  db.project.update({ where: { id }, data, select: publicFields });

const remove = (id, db = prisma) => db.project.delete({ where: { id }, select: { id: true } });

// For webhooks only: includes the encrypted webhook secret.
const findForWebhook = (id, db = prisma) =>
  db.project.findUnique({
    where: { id },
    select: {
      id: true,
      autoDeploy: true,
      defaultBranch: true,
      webhookSecretEnc: true,
      targets: { select: { id: true, branch: true } },
    },
  });

const countBusyTargets = (projectId, db = prisma) =>
  db.target.count({ where: { projectId, activeDeploymentId: { not: null } } });

module.exports = {
  publicFields,
  findById,
  findByIdWithTargets,
  list,
  create,
  update,
  remove,
  findForWebhook,
  countBusyTargets,
};
