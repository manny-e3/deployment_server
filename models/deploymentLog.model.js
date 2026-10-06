const prisma = require('./prisma');

/** Log lines with seq greater than afterSeq, oldest first. */
const listAfter = (deploymentId, afterSeq, limit, db = prisma) =>
  db.deploymentLog.findMany({
    where: { deploymentId, seq: { gt: afterSeq } },
    select: { seq: true, stream: true, line: true, createdAt: true },
    orderBy: { seq: 'asc' },
    take: limit,
  });

module.exports = { listAfter };
