const prisma = require('./prisma');

// Fields the API may return. secretEnc and passphraseEnc are never selected here.
const publicFields = {
  id: true,
  organizationId: true,
  name: true,
  host: true,
  port: true,
  username: true,
  authType: true,
  hostFingerprint: true,
  publicKey: true,
  setupToken: true,
  setupCompletedAt: true,
  lastCheckAt: true,
  lastCheckOk: true,
  createdAt: true,
  updatedAt: true,
};

const findById = (id, db = prisma) => db.server.findUnique({ where: { id }, select: publicFields });

// Includes the encrypted secrets: only for opening an SSH connection.
const findByIdWithSecrets = (id, db = prisma) => db.server.findUnique({ where: { id } });

/** Sorted by name, cursor-paginated: returns { items, nextCursor }. */
async function list({ limit = 50, cursor, organizationId } = {}, db = prisma) {
  const where = organizationId ? { organizationId } : {};
  const rows = await db.server.findMany({
    where,
    select: publicFields,
    orderBy: { name: 'asc' },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items.at(-1).id : null };
}

const create = (data, db = prisma) => db.server.create({ data, select: publicFields });

const update = (id, data, db = prisma) =>
  db.server.update({ where: { id }, data, select: publicFields });

const remove = (id, db = prisma) => db.server.delete({ where: { id }, select: { id: true } });

const countTargets = (serverId, db = prisma) => db.target.count({ where: { serverId } });

const findBySetupToken = (setupToken, db = prisma) =>
  db.server.findUnique({ where: { setupToken } });

module.exports = {
  publicFields,
  findById,
  findByIdWithSecrets,
  findBySetupToken,
  list,
  create,
  update,
  remove,
  countTargets,
};
