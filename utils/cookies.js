const { env } = require('./env');
const { durationToMs, randomToken } = require('./tokens');

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const CSRF_COOKIE = 'csrf_token';

// In HTTPS production cross-site, SameSite=None and Secure=true are mandatory;
// On plain HTTP (e.g. intranet/development), Secure=false and SameSite=lax are required so browsers do not drop cookies.
const isHttps = (env.APP_URL || '').startsWith('https://');
const base = {
  secure: isHttps,
  sameSite: isHttps ? 'none' : 'lax',
  path: '/',
};

/** Sets the session cookies and sets the X-CSRF-Token response header. */
function setSessionCookies(res, { accessToken, refreshToken }) {
  const refreshMaxAge = durationToMs(env.REFRESH_TOKEN_TTL);
  const csrfToken = randomToken();
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base,
    httpOnly: true,
    maxAge: durationToMs(env.ACCESS_TOKEN_TTL),
  });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, httpOnly: true, maxAge: refreshMaxAge });
  res.cookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false, maxAge: refreshMaxAge });
  res.setHeader('X-CSRF-Token', csrfToken);
  return csrfToken;
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
