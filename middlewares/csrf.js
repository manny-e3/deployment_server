const crypto = require('node:crypto');
const { CSRF_COOKIE } = require('../utils/cookies');
const { Forbidden } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Login has no session yet; it is the request that sets the CSRF cookie.
const EXEMPT_PATHS = new Set(['/auth/login']);

const sameToken = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * Double-submit check: on every write request the X-CSRF-Token header must equal the csrf_token
 * cookie. Another site can make the browser send the cookie, but cannot read it to set the header.
 */
function csrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method) || EXEMPT_PATHS.has(req.path)) return next();

  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (cookie && header && sameToken(cookie, header)) return next();

  next(new Forbidden('Missing or wrong X-CSRF-Token header', 'CSRF_FAILED'));
}

module.exports = csrf;
