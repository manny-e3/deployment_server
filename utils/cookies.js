const { env } = require('./env');
const { durationToMs, randomToken } = require('./tokens');

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const CSRF_COOKIE = 'csrf_token';

// Secure is off outside production so cookies work over plain http://localhost.
// In production cross-site (deploy.travaiq.com -> onrender.com), SameSite=None and Secure=true are mandatory
const isProd = env.NODE_ENV === 'production';
const base = {
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  path: '/',
};

/** Sets the session cookies. JavaScript can read only the CSRF cookie. */
function setSessionCookies(res, { accessToken, refreshToken }) {
  const refreshMaxAge = durationToMs(env.REFRESH_TOKEN_TTL);
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base,
    httpOnly: true,
    maxAge: durationToMs(env.ACCESS_TOKEN_TTL),
  });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, httpOnly: true, maxAge: refreshMaxAge });
  res.cookie(CSRF_COOKIE, randomToken(), { ...base, httpOnly: false, maxAge: refreshMaxAge });
}

function clearSessionCookies(res) {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) res.clearCookie(name, base);
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
  setSessionCookies,
  clearSessionCookies,
};
