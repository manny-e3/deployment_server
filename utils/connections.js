const prisma = require('../models/prisma');
const { deployQueue, maintenanceQueue, queueConnection } = require('./queue');
const { redis } = require('./redis');

async function closeConnections() {
  await Promise.allSettled([deployQueue.close(), maintenanceQueue.close()]);
  await Promise.allSettled([queueConnection.quit(), redis.quit(), prisma.$disconnect()]);
}

module.exports = { closeConnections };
