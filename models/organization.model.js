const prisma = require('./prisma');

const publicFields = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

const findById = (id, db = prisma) => db.organization.findUnique({ where: { id }, select: publicFields });

const findByName = (name, db = prisma) => db.organization.findFirst({ where: { name }, select: publicFields });

const create = (data, db = prisma) => db.organization.create({ data, select: publicFields });

const update = (id, data, db = prisma) => db.organization.update({ where: { id }, data, select: publicFields });

module.exports = {
  publicFields,
  findById,
  findByName,
  create,
  update,
};

