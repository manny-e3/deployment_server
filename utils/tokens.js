const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { env } = require('./env');

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** '15m' -> 900000. Formats are already checked by env.js. */
function durationToMs(value) {
  return Number.parseInt(value, 10) * UNIT_MS[value.at(-1)];
}

// Access token: a short-lived JWT holding the user id, role and tokenVersion.
function signAccessToken(user) {
  return jwt.sign({ role: user.role, tv: user.tokenVersion }, env.JWT_SECRET, {
    subject: user.id,
    expiresIn: env.ACCESS_TOKEN_TTL,
    algorithm: 'HS256',
  });
}

/** Returns the payload, or throws if the token is invalid or expired. */
function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
}

// Refresh tokens and CSRF tokens are random 256-bit values.
const randomToken = () => crypto.randomBytes(32).toString('base64url');

// Only this hash of a refresh token is stored, never the token itself.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = { durationToMs, signAccessToken, verifyAccessToken, randomToken, hashToken };
