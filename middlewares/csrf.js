const crypto = require('node:crypto');
const { CSRF_COOKIE } = require('../utils/cookies');
const { Forbidden } = require('../utils/errors');
const { env } = require('../utils/env');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Login and refresh do not check existing CSRF token
const EXEMPT_PATHS = new Set(['/auth/login', '/auth/refresh']);

const sameToken = (a, b) => {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * Double-submit check & Origin Verification:
 * 1. Safe methods (GET, HEAD, OPTIONS) and auth bootstrap (login, refresh) are exempt.
 * 2. On same-origin requests or when cookies are present, the double-submit token match (cookie === header) passes.
 * 3. On cross-origin requests from our verified frontend (deploy.travaiq.com), the browser's
 *    immutable Origin header is verified against the allowed origins whitelist.
 */
function csrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const normPath = (req.path || '').replace(/\/$/, '');
  if (EXEMPT_PATHS.has(normPath) || EXEMPT_PATHS.has(req.path)) return next();

  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (cookie && header && sameToken(cookie, header)) return next();

  // Allow verified origins (prevents cross-origin document.cookie read limitations)
  const origin = req.get('origin');
  const allowed = [
    env.APP_URL,
    'https://deploy.travaiq.com',
    'http://localhost:5173',
    'http://localhost:3000',
  ].filter(Boolean);

  if (origin && allowed.includes(origin)) {
    return next();
  }

  next(new Forbidden('Missing or wrong X-CSRF-Token header', 'CSRF_FAILED'));
}

module.exports = csrf;
