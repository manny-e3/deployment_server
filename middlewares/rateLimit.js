const { redis } = require('../utils/redis');
const { logger } = require('../utils/logger');
const { TooManyRequests } = require('../utils/errors');
const { ACCESS_COOKIE } = require('../utils/cookies');
const { verifyAccessToken } = require('../utils/tokens');

/**
 * Fixed-window rate limit stored in Redis.
 *   rateLimit({ name: 'login', limit: 5, windowSec: 900, key: (req) => req.ip })
 * The returned middleware also has .reset(req), to clear the counter (e.g. after a good login).
 * If Redis is down, requests are let through and a warning is logged.
 */
function rateLimit({ name, limit, windowSec, key }) {
  const redisKey = (req) => `rl:${name}:${key(req)}`;

  const middleware = async (req, res, next) => {
    const k = redisKey(req);
    let count;
    let ttl;
    try {
      const results = await redis.multi().incr(k).expire(k, windowSec, 'NX').ttl(k).exec();
      count = results[0][1];
      ttl = results[2][1];
    } catch (err) {
      logger.warn({ err, limiter: name }, 'rate limit check failed, allowing request');
      return next();
    }

    if (count > limit) {
      res.set('Retry-After', String(ttl > 0 ? ttl : windowSec));
      return next(new TooManyRequests());
    }
    next();
  };

  middleware.reset = async (req) => {
    try {
      await redis.del(redisKey(req));
    } catch (err) {
      logger.warn({ err, limiter: name }, 'rate limit reset failed');
    }
  };

  return middleware;
}

// 5 login attempts per 15 minutes for each IP + email pair. Runs after validate, so the email
// is already lower-cased.
const loginLimiter = rateLimit({
  name: 'login',
  limit: 5,
  windowSec: 15 * 60,
  key: (req) => `${req.ip}:${req.body.email}`,
});

// 300 API requests per minute per user (or per IP before login). The user is read from the
// access token without a database call; a bad token simply counts against the IP.
const apiLimiter = rateLimit({
  name: 'api',
  limit: 300,
  windowSec: 60,
  key: (req) => {
    try {
      return `user:${verifyAccessToken(req.cookies?.[ACCESS_COOKIE]).sub}`;
    } catch {
      return `ip:${req.ip}`;
    }
  },
});

module.exports = { rateLimit, loginLimiter, apiLimiter };
