const argon2 = require('argon2');
const prisma = require('../models/prisma');
const userModel = require('../models/user.model');
const refreshTokenModel = require('../models/refreshToken.model');
const audit = require('./audit.service');
const authCache = require('../utils/authCache');
const { env } = require('../utils/env');
const { BadRequest, Unauthorized } = require('../utils/errors');
const {
  durationToMs,
  hashToken,
  randomToken,
  signAccessToken,
} = require('../utils/tokens');

const hashPassword = (password) => argon2.hash(password, { type: argon2.argon2id });

// Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
let dummyHash;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password'));

const toPublic = ({ id, name, email, role, isActive, lastLoginAt, createdAt }) => ({
  id,
  name,
  email,
  role,
  isActive,
  lastLoginAt,
  createdAt,
});

/** Creates a refresh token row and returns a fresh token pair for the user. */
async function issueSession(user, db = prisma) {
  const refreshToken = randomToken();
  await refreshTokenModel.create(
    {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + durationToMs(env.REFRESH_TOKEN_TTL)),
    },
    db,
  );
  return { accessToken: signAccessToken(user), refreshToken };
}

/** Logs the user out everywhere: revokes every refresh token and invalidates access tokens. */
async function endAllSessions(userId, db = prisma) {
  await refreshTokenModel.revokeAllForUser(userId, db);
  await userModel.update(userId, { tokenVersion: { increment: 1 } }, db);
  await authCache.invalidate(userId);
}

async function login({ email, password, ip }) {
  const user = await userModel.findByEmailWithHash(email);
  const passwordOk = await argon2.verify(user?.passwordHash ?? (await getDummyHash()), password);

  if (!user || !passwordOk || !user.isActive) {
    const reason = !user ? 'unknown_email' : !passwordOk ? 'wrong_password' : 'inactive';
    await audit.record({
      userId: user?.id,
      action: 'auth.login_failed',
      entity: 'user',
      entityId: user?.id,
      details: { email, reason },
      ip,
    });
    // One message for every case, so it never reveals which emails exist.
    throw new Unauthorized('The email or password is wrong', 'INVALID_CREDENTIALS');
  }

  const updated = await userModel.update(user.id, { lastLoginAt: new Date() });
  const tokens = await issueSession(updated);
  await audit.record({ userId: user.id, action: 'auth.login', entity: 'user', entityId: user.id, ip });
  return { user: toPublic(updated), tokens };
}

/** Swaps a refresh token for a new pair. Reusing a revoked token ends all the user's sessions. */
async function refresh({ refreshToken, ip }) {
  const sessionEnded = new Unauthorized('Your session has ended, please log in again');
  if (!refreshToken) throw sessionEnded;

  const row = await refreshTokenModel.findByHash(hashToken(refreshToken));
  if (!row) throw sessionEnded;

  const reuse = async () => {
    await endAllSessions(row.userId);
    await audit.record({
      userId: row.userId,
      action: 'auth.refresh_reuse',
      entity: 'user',
      entityId: row.userId,
      ip,
    });
    return sessionEnded;
  };

  if (row.revokedAt) throw await reuse();
  if (row.expiresAt <= new Date() || !row.user.isActive) throw sessionEnded;

  // Claim the token atomically: if two requests race, only one wins.
  if (!(await refreshTokenModel.revokeIfActive(row.id))) throw await reuse();

  const tokens = await issueSession(row.user);
  return { user: toPublic(row.user), tokens };
}

async function logout({ refreshToken, ip }) {
  if (!refreshToken) return;
  const row = await refreshTokenModel.findByHash(hashToken(refreshToken));
  if (!row) return;
  await refreshTokenModel.revokeIfActive(row.id);
  await audit.record({ userId: row.userId, action: 'auth.logout', entity: 'user', entityId: row.userId, ip });
}

/** Changes the password, logs out every other session and returns a new pair for this one. */
async function changePassword({ userId, currentPassword, newPassword, ip }) {
  const user = await userModel.findByIdWithHash(userId);
  if (!user || !(await argon2.verify(user.passwordHash, currentPassword))) {
    throw new BadRequest('INVALID_CURRENT_PASSWORD', 'Your current password is wrong');
  }

  const passwordHash = await hashPassword(newPassword);
  const tokens = await prisma.$transaction(async (tx) => {
    await refreshTokenModel.revokeAllForUser(userId, tx);
    const updated = await userModel.update(
      userId,
      { passwordHash, tokenVersion: { increment: 1 } },
      tx,
    );
    return issueSession(updated, tx);
  });
  await authCache.invalidate(userId);

  await audit.record({ userId, action: 'auth.password_changed', entity: 'user', entityId: userId, ip });
  return tokens;
}

module.exports = { hashPassword, endAllSessions, login, refresh, logout, changePassword };
