// Caches each user's role, tokenVersion and active flag for 60 s, so `authenticate` doesn't
// query MySQL on every request. Any change to those fields must call invalidate().
// If Redis is down, everything falls back to MySQL.
const { redis } = require('./redis');
const { logger } = require('./logger');

const TTL_SECONDS = 60;
const key = (userId) => `auth:user:${userId}`;

async function get(userId) {
  try {
    const cached = await redis.get(key(userId));
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    logger.warn({ err }, 'auth cache read failed');
    return null;
  }
}

async function set(userId, state) {
  try {
    await redis.set(key(userId), JSON.stringify(state), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, 'auth cache write failed');
  }
}

async function invalidate(userId) {
  try {
    await redis.del(key(userId));
  } catch (err) {
    // The entry expires within 60 s anyway.
    logger.warn({ err }, 'auth cache invalidate failed');
  }
}

module.exports = { get, set, invalidate };
