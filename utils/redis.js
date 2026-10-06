const { Redis } = require('ioredis');
const { env } = require('./env');
const { logger } = require('./logger');

const watch = (conn, name) => {
  conn.on('error', (err) => logger.warn({ err, connection: name }, 'redis connection error'));
  return conn;
};

// General commands (rate limits, caches, cancel keys). Fails a command after one retry
// instead of queueing it forever while Redis is down.
const redis = watch(
  new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectionName: 'commands' }),
  'commands',
);

// BullMQ and pub/sub need their own connections, with retries left to BullMQ.
const createRedisConnection = (name) =>
  watch(new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, connectionName: name }), name);

module.exports = { redis, createRedisConnection };
