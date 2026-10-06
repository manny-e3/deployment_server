const prisma = require('./prisma');

// Fields the API may return. passwordHash and tokenVersion never leave the server.
const publicFields = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
};

// What `authenticate` needs to check a session.
const authFields = { id: true, name: true, email: true, role: true, isActive: true, tokenVersion: true };

const findById = (id, db = prisma) => db.user.findUnique({ where: { id }, select: publicFields });

const findAuthState = (id, db = prisma) => db.user.findUnique({ where: { id }, select: authFields });

// Includes passwordHash: only for checking a password.
const findByEmailWithHash = (email, db = prisma) => db.user.findUnique({ where: { email } });
const findByIdWithHash = (id, db = prisma) => db.user.findUnique({ where: { id } });

/** Newest first, cursor-paginated: returns { items, nextCursor }. */
async function list({ limit, cursor }, db = prisma) {
  const rows = await db.user.findMany({
    select: publicFields,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items.at(-1).id : null };
}

const create = (data, db = prisma) => db.user.create({ data, select: publicFields });

// Returns the public fields plus tokenVersion, for issuing a new access token.
const update = (id, data, db = prisma) =>
  db.user.update({ where: { id }, data, select: { ...publicFields, tokenVersion: true } });

module.exports = {
  publicFields,
  findById,
  findAuthState,
  findByEmailWithHash,
  findByIdWithHash,
  list,
  create,
  update,
};
