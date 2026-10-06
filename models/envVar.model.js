const prisma = require('./prisma');

const listKeys = (targetId, db = prisma) =>
  db.envVar.findMany({ where: { targetId }, select: { key: true }, orderBy: { key: 'asc' } });

// Includes the encrypted values: only for comparing on replace, and for the worker.
const listWithValues = (targetId, db = prisma) =>
  db.envVar.findMany({ where: { targetId }, select: { key: true, valueEnc: true } });

/** Replaces the target's whole set of variables. Run inside a transaction. */
async function replaceAll(targetId, rows, db = prisma) {
  await db.envVar.deleteMany({ where: { targetId } });
  if (rows.length) {
    await db.envVar.createMany({ data: rows.map((r) => ({ targetId, ...r })) });
  }
}

module.exports = { listKeys, listWithValues, replaceAll };
