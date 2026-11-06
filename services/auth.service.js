const { hashPassword, verifyPassword } = require('../utils/password');
const prisma = require('../models/prisma');
const userModel = require('../models/user.model');
const refreshTokenModel = require('../models/refreshToken.model');
const passwordResetTokenModel = require('../models/passwordResetToken.model');
const emailService = require('./email.service');
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

// Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword('not-a-real-password'));

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
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);

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
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
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

/** Initiates a forgot password flow, generating a single-use token and emailing the user. */
async function forgotPassword({ email, ip }) {
  const genericMessage = 'If an account exists with that email address, we have sent a password reset link.';
  const user = await userModel.findByEmailWithHash(email);

  if (!user || !user.isActive) {
    await audit.record({
      userId: user?.id,
      action: 'auth.forgot_password_unknown',
      entity: 'user',
      entityId: user?.id,
      details: { email },
      ip,
    });
    return { message: genericMessage };
  }

  // Invalidate any existing unused reset tokens for this user
  await passwordResetTokenModel.invalidateAllForUser(user.id);

  // Generate a cryptographically secure 32-byte URL-safe token
  const resetToken = randomToken();
  const tokenHash = hashToken(resetToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await passwordResetTokenModel.create({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const appUrl = (env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

  try {
    await emailService.sendPasswordResetEmail({
      to: user.email,
      userName: user.name,
      resetUrl,
      expiresInMinutes: 60,
    });
  } catch (err) {
    throw new BadRequest('EMAIL_SEND_FAILED', 'Failed to send password reset email. Please try again later.');
  }

  await audit.record({
    userId: user.id,
    action: 'auth.forgot_password_requested',
    entity: 'user',
    entityId: user.id,
    details: { email: user.email },
    ip,
  });

  return { message: genericMessage };
}

/** Verifies whether a reset token is valid and unexpired without using it. */
async function verifyResetToken({ token }) {
  if (!token) {
    throw new BadRequest('INVALID_TOKEN', 'Reset token is required.');
  }

  const tokenHash = hashToken(token);
  const record = await passwordResetTokenModel.findByHash(tokenHash);

  if (!record || record.usedAt || record.expiresAt <= new Date() || !record.user?.isActive) {
    throw new BadRequest('INVALID_OR_EXPIRED_TOKEN', 'This password reset link is invalid or has expired.');
  }

  return { valid: true, email: record.user.email };
}

/** Resets the user's password using a valid reset token. Revokes all active sessions. */
async function resetPassword({ token, newPassword, ip }) {
  if (!token) {
    throw new BadRequest('INVALID_TOKEN', 'Reset token is required.');
  }

  const tokenHash = hashToken(token);
  const record = await passwordResetTokenModel.findByHash(tokenHash);

  if (!record || record.usedAt || record.expiresAt <= new Date() || !record.user?.isActive) {
    throw new BadRequest('INVALID_OR_EXPIRED_TOKEN', 'This password reset link is invalid or has expired.');
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    // Mark token as used
    await passwordResetTokenModel.markUsed(record.id, tx);
    // Invalidate any other reset tokens for this user
    await passwordResetTokenModel.invalidateAllForUser(record.userId, tx);
    // Invalidate all active sessions across all devices
    await refreshTokenModel.revokeAllForUser(record.userId, tx);
    // Update user's password and increment tokenVersion (invalidates all access tokens)
    await userModel.update(
      record.userId,
      { passwordHash, tokenVersion: { increment: 1 } },
      tx,
    );
  });

  await authCache.invalidate(record.userId);

  await audit.record({
    userId: record.userId,
    action: 'auth.password_reset',
    entity: 'user',
    entityId: record.userId,
    ip,
  });

  return { message: 'Your password has been reset successfully. You can now log in.' };
}

module.exports = {
  hashPassword,
  endAllSessions,
  login,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  verifyResetToken,
  resetPassword,
};
