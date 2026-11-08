const prisma = require('./prisma');

const create = (data, db = prisma) => db.emailConfirmationToken.create({ data });

const findByHash = (tokenHash, db = prisma) =>
  db.emailConfirmationToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

async function markConfirmed(id, db = prisma) {
  const { count } = await db.emailConfirmationToken.updateMany({
    where: { id, confirmedAt: null },
    data: { confirmedAt: new Date() },
  });
  return count === 1;
}

const invalidateAllForUser = (userId, db = prisma) =>
  db.emailConfirmationToken.updateMany({
    where: { userId, confirmedAt: null },
    data: { confirmedAt: new Date() },
  });

module.exports = { create, findByHash, markConfirmed, invalidateAllForUser };

