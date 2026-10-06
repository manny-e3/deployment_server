const prisma = require('./prisma');

const publicFields = {
  id: true,
  projectId: true,
  serverId: true,
  name: true,
  path: true,
  branch: true,
  preDeploy: true,
  postDeploy: true,
  healthCheckUrl: true,
  activeDeploymentId: true,
  createdAt: true,
};

const findById = (id, db = prisma) => db.target.findUnique({ where: { id }, select: publicFields });

/** A target only if it belongs to the given project. */
const findInProject = (projectId, id, db = prisma) =>
  db.target.findFirst({ where: { id, projectId }, select: publicFields });

const create = (data, db = prisma) => db.target.create({ data, select: publicFields });

const update = (id, data, db = prisma) =>
  db.target.update({ where: { id }, data, select: publicFields });

const remove = (id, db = prisma) => db.target.delete({ where: { id }, select: { id: true } });

/**
 * Takes the target's deploy lock for a deployment. Returns false if another deploy holds it.
 * One conditional update, so two requests at the same moment can never both win.
 */
async function claimLock(targetId, deploymentId, db = prisma) {
  const { count } = await db.target.updateMany({
    where: { id: targetId, activeDeploymentId: null },
    data: { activeDeploymentId: deploymentId },
  });
  return count === 1;
}

/** Releases the lock, but only if this deployment still holds it. */
const releaseLock = (deploymentId, db = prisma) =>
  db.target.updateMany({
    where: { activeDeploymentId: deploymentId },
    data: { activeDeploymentId: null },
  });

module.exports = {
  publicFields,
  findById,
  findInProject,
  create,
  update,
  remove,
  claimLock,
  releaseLock,
};
