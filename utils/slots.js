// A per-project limit on deploys running at once, kept in Redis.
// Each running deploy holds a slot (a member of a sorted set, scored by when it expires), so a
// slot left by a crashed worker frees itself once the deploy could no longer be running.
const { redis } = require('./redis');
const { logger } = require('./logger');

const key = (projectId) => `deploy-slots:${projectId}`;

// KEYS[1] = set; ARGV = now, limit, member, expiresAt
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 1 end
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
  redis.call('PEXPIREAT', KEYS[1], ARGV[4])
  return 1
end
return 0`;

/** True if the deploy got a slot. If Redis is down the limit is skipped, never blocking deploys. */
async function acquire(projectId, deploymentId, limit, holdMs) {
  try {
    const now = Date.now();
    return (await redis.eval(ACQUIRE, 1, key(projectId), now, limit, deploymentId, now + holdMs)) === 1;
  } catch (err) {
    logger.warn({ err, projectId }, 'deploy slot check failed, not limiting');
    return true;
  }
}

async function release(projectId, deploymentId) {
  await redis.zrem(key(projectId), deploymentId).catch(() => {});
}

/** Drops every slot; the worker calls this on startup, when no deploy can be running. */
async function clearAll() {
  const keys = await redis.keys('deploy-slots:*');
  if (keys.length) await redis.del(...keys);
}

module.exports = { acquire, release, clearAll };
