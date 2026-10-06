const userModel = require('../models/user.model');
const authCache = require('../utils/authCache');
const { ACCESS_COOKIE } = require('../utils/cookies');
const { Unauthorized } = require('../utils/errors');
const { verifyAccessToken } = require('../utils/tokens');

/**
 * Checks an access token and returns { id, name, email, role }, or throws Unauthorized.
 * The token's tokenVersion must match the user row (cached up to 60 s), so a deactivated user
 * or a changed role takes effect within a minute, and at once when the cache is cleared.
 * Also used by the Socket.IO server.
 */
async function resolveSession(token) {
  if (!token) throw new Unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new Unauthorized('Your session has expired', 'SESSION_EXPIRED');
  }

  let state = await authCache.get(payload.sub);
  if (!state) {
    state = await userModel.findAuthState(payload.sub);
    if (state) await authCache.set(payload.sub, state);
  }

  if (!state || !state.isActive || state.tokenVersion !== payload.tv) {
    throw new Unauthorized('Your session has ended, please log in again');
  }
  return { id: state.id, name: state.name, email: state.email, role: state.role };
}

/** Reads the access-token cookie and sets req.user. */
async function authenticate(req, _res, next) {
  req.user = await resolveSession(req.cookies?.[ACCESS_COOKIE]);
  next();
}

module.exports = authenticate;
module.exports.resolveSession = resolveSession;
