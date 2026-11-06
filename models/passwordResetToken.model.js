const prisma = require('./prisma');

const create = (data, db = prisma) => db.passwordResetToken.create({ data });

const findByHash = (tokenHash, db = prisma) =>
  db.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

async function markUsed(id, db = prisma) {
  const { count } = await db.passwordResetToken.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}

const invalidateAllForUser = (userId, db = prisma) =>
  db.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

module.exports = { create, findByHash, markUsed, invalidateAllForUser };

