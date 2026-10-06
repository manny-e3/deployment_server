const prisma = require('./prisma');

const create = (data, db = prisma) => db.webhookDelivery.create({ data, select: { id: true } });

const update = (id, data, db = prisma) =>
  db.webhookDelivery.update({ where: { id }, data, select: { id: true } });

module.exports = { create, update };
