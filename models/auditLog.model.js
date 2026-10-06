const prisma = require('./prisma');

const create = (data, db = prisma) => db.auditLog.create({ data });

/**
 * Newest first, filtered and cursor-paginated: returns { items, nextCursor }.
 * Ids are BigInts in MySQL; they are returned as strings so they survive JSON.
 * An action ending in * matches by prefix, e.g. "deploy.*".
 */
async function list({ limit, cursor, userId, action, entity, entityId, from, to }, db = prisma) {
  const where = {
    ...(userId && { userId }),
    ...(action && (action.endsWith('*') ? { action: { startsWith: action.slice(0, -1) } } : { action })),
    ...(entity && { entity }),
    ...(entityId && { entityId }),
    ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
  };
  const rows = await db.auditLog.findMany({
    where,
    select: {
      id: true,
      action: true,
      entity: true,
      entityId: true,
      details: true,
      ip: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
    ...(cursor && { cursor: { id: BigInt(cursor) }, skip: 1 }),
  });
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({ ...r, id: r.id.toString() }));
  return { items, nextCursor: hasMore ? items.at(-1).id : null };
}

module.exports = { create, list };
