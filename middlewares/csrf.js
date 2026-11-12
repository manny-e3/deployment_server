const crypto = require('node:crypto');
const { CSRF_COOKIE } = require('../utils/cookies');
const { Forbidden } = require('../utils/errors');
const { env } = require('../utils/env');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Auth bootstrap & password recovery do not check existing CSRF token
const EXEMPT_PATHS = new Set([
  '/auth/register',
  '/auth/confirm-email',
  '/auth/resend-confirmation',
  '/auth/accept-invite',
  '/auth/login',
  '/auth/refresh',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/contact',
  '/api/v1/contact',
  '/api/v1/auth/register',
  '/api/v1/auth/confirm-email',
  '/api/v1/auth/resend-confirmation',
  '/api/v1/auth/accept-invite',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
]);

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
 * 3. On cross-origin requests from our verified frontend (e.g. portalops.online), the browser's
 *    immutable Origin header is verified against the allowed origins whitelist.
 */
function csrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const normPath = (req.path || '').replace(/\/+$/, '');
  const origPath = (req.originalUrl ? req.originalUrl.split('?')[0] : '').replace(/\/+$/, '');
  const strippedOrigPath = origPath.replace(/^\/api\/v\d+/, '');

  if (
    EXEMPT_PATHS.has(normPath) ||
    EXEMPT_PATHS.has(origPath) ||
    EXEMPT_PATHS.has(strippedOrigPath) ||
    normPath.endsWith('/auth/register') ||
    normPath.endsWith('/auth/confirm-email') ||
    normPath.endsWith('/auth/resend-confirmation') ||
    normPath.endsWith('/auth/login') ||
    normPath.endsWith('/auth/refresh') ||
    normPath.endsWith('/auth/forgot-password') ||
    normPath.endsWith('/auth/reset-password') ||
    normPath.endsWith('/auth/accept-invite') ||
    origPath.endsWith('/auth/register') ||
    origPath.endsWith('/auth/confirm-email') ||
    origPath.endsWith('/auth/resend-confirmation') ||
    origPath.endsWith('/auth/login') ||
    origPath.endsWith('/auth/refresh') ||
    origPath.endsWith('/auth/forgot-password') ||
    origPath.endsWith('/auth/reset-password') ||
    origPath.endsWith('/auth/accept-invite') ||
    normPath.endsWith('/contact') ||
    origPath.endsWith('/contact') ||
    strippedOrigPath.endsWith('/contact')
  ) {
    return next();
  }

  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (cookie && header && sameToken(cookie, header)) return next();

  // Allow verified origins and same-origin requests
  const host = req.get('host');
  const origin = req.get('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (host && originHost === host) return next();
    } catch {}
  }

  const allowed = [
    env.APP_URL,
    'https://portalops.online',
    'https://www.portalops.online',
    'http://portalops.online',
    'http://www.portalops.online',
    'https://deploy.travaiq.com',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://101-php-01.fmdqgroup.com',
    'https://101-php-01.fmdqgroup.com',
  ].filter(Boolean);

  if (origin && (allowed.includes(origin) || allowed.some(a => a && origin.startsWith(a)))) {
    return next();
  }

  next(new Forbidden('Missing or wrong X-CSRF-Token header', 'CSRF_FAILED'));
}

module.exports = csrf;
