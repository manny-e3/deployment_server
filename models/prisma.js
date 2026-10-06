// One Prisma client for the whole app. The tables themselves are defined in prisma/schema.prisma.
const { PrismaClient } = require('@prisma/client');
const { env } = require('../utils/env');
const { logger } = require('../utils/logger');

const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

prisma.$on('warn', (e) => logger.warn({ target: e.target }, e.message));
prisma.$on('error', (e) => logger.error({ target: e.target }, e.message));

module.exports = prisma;
