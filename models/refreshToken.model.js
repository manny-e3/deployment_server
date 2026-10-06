const prisma = require('./prisma');

const create = (data, db = prisma) => db.refreshToken.create({ data });

const findByHash = (tokenHash, db = prisma) =>
  db.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });

/** Revokes one token if it is still active. Returns false if it was already revoked. */
async function revokeIfActive(id, db = prisma) {
  const { count } = await db.refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count === 1;
}

const revokeAllForUser = (userId, db = prisma) =>
  db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

module.exports = { create, findByHash, revokeIfActive, revokeAllForUser };
