const { hashPassword, verifyPassword } = require('../utils/password');
const prisma = require('../models/prisma');
const userModel = require('../models/user.model');
const organizationModel = require('../models/organization.model');
const refreshTokenModel = require('../models/refreshToken.model');
const passwordResetTokenModel = require('../models/passwordResetToken.model');
const emailConfirmationTokenModel = require('../models/emailConfirmationToken.model');
const emailService = require('./email.service');
const audit = require('./audit.service');
const authCache = require('../utils/authCache');
const { env } = require('../utils/env');
const { logger } = require('../utils/logger');
const { BadRequest, Unauthorized, Conflict } = require('../utils/errors');
const { checkDisposableEmail } = require('../utils/disposableEmail');
const {
  durationToMs,
  hashToken,
  randomToken,
  signAccessToken,
} = require('../utils/tokens');

// Checked against when the email is unknown, so a wrong email takes as long as a wrong password.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword('not-a-real-password'));

const toPublic = ({
  id,
  name,
  email,
  role,
  roleTitle,
  isSuperAdmin,
  isActive,
  isEmailVerified,
  notifyDeployFailures,
  notifyDeploySuccess,
  notifyTeamChanges,
  organizationId,
  organization,
  lastLoginAt,
  createdAt,
}) => ({
  id,
  name,
  email,
  role,
  roleTitle: roleTitle || null,
  isSuperAdmin: Boolean(isSuperAdmin),
  isActive,
  isEmailVerified: Boolean(isEmailVerified),
  notifyDeployFailures: notifyDeployFailures !== false,
  notifyDeploySuccess: notifyDeploySuccess !== false,
  notifyTeamChanges: notifyTeamChanges !== false,
  organizationId: organizationId || organization?.id || null,
  organizationName: organization?.name || null,
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

  // Check if organization is suspended
  if (user.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { isActive: true },
    });
    if (org && org.isActive === false && !user.isSuperAdmin) {
      throw new Unauthorized(
        'This workspace is currently suspended by platform administration. Please contact support.',
        'WORKSPACE_SUSPENDED'
      );
    }
  }

  const updated = await userModel.update(user.id, { lastLoginAt: new Date() });
  await authCache.invalidate(user.id);
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

/** Updates the profile fields (name, roleTitle, notification preferences) of the currently authenticated user. */
async function updateProfile({
  userId,
  name,
  roleTitle,
  notifyDeployFailures,
  notifyDeploySuccess,
  notifyTeamChanges,
  ip,
}) {
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (roleTitle !== undefined) data.roleTitle = roleTitle.trim();
  if (notifyDeployFailures !== undefined) data.notifyDeployFailures = Boolean(notifyDeployFailures);
  if (notifyDeploySuccess !== undefined) data.notifyDeploySuccess = Boolean(notifyDeploySuccess);
  if (notifyTeamChanges !== undefined) data.notifyTeamChanges = Boolean(notifyTeamChanges);
  if (Object.keys(data).length === 0) {
    throw new BadRequest('EMPTY_UPDATE', 'Provide at least one field to update');
  }

  const updated = await userModel.update(userId, data);
  await authCache.invalidate(userId);
  await audit.record({
    userId,
    action: 'auth.profile_updated',
    entity: 'user',
    entityId: userId,
    details: data,
    ip,
  });
  return toPublic(updated);
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

  const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
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

/** Registers a new user account, sends confirmation email, records audit event, and returns tokens. */
async function register({ name, email, password, organizationName, role, ip }) {
  const cleanEmail = email.toLowerCase().trim();

  const disposableCheck = checkDisposableEmail(cleanEmail);
  if (disposableCheck.isDisposable) {
    throw new BadRequest('DISPOSABLE_EMAIL', disposableCheck.message);
  }

  const existing = await userModel.findByEmailWithHash(cleanEmail);
  if (existing) {
    throw new Conflict('EMAIL_EXISTS', 'An account with this email address already exists.');
  }

  const totalUsers = await prisma.user.count();
  // The first user registered in the system receives ADMIN role.
  // Otherwise, if a valid role is provided (ADMIN, DEPLOYER, VIEWER), assign it; default is ADMIN for workspace owner.
  let assignedRole = 'ADMIN';
  if (totalUsers > 0 && role && ['ADMIN', 'DEPLOYER', 'VIEWER'].includes(role)) {
    assignedRole = role;
  }

  const orgName = organizationName?.trim() || `${name.trim()}'s Workspace`;
  const org = await organizationModel.create({ name: orgName });

  const passwordHash = await hashPassword(password);
  const user = await userModel.create({
    name: name.trim(),
    email: cleanEmail,
    passwordHash,
    role: assignedRole,
    isActive: true,
    isEmailVerified: false,
    organizationId: org.id,
  });

  const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');

  // Generate a cryptographically secure 32-byte confirmation token (valid 24h)
  const confirmationToken = randomToken();
  const tokenHash = hashToken(confirmationToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await emailConfirmationTokenModel.create({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const confirmUrl = `${appUrl}/confirm-email?token=${encodeURIComponent(confirmationToken)}`;
  const loginUrl = `${appUrl}/login`;

  let emailSent = false;
  try {
    await emailService.sendRegistrationConfirmationEmail({
      to: user.email,
      userName: user.name,
      organizationName: organizationName?.trim() || 'My Organization',
      role: user.role,
      confirmUrl,
      loginUrl,
      expiresInHours: 24,
    });
    emailSent = true;
  } catch (err) {
    logger.error({ err, email: user.email }, 'Failed to dispatch registration confirmation email');
  }

  const tokens = await issueSession(user);

  await audit.record({
    userId: user.id,
    action: 'auth.registered',
    entity: 'user',
    entityId: user.id,
    details: {
      email: user.email,
      role: user.role,
      organizationName: organizationName?.trim(),
      emailSent,
    },
    ip,
  });

  return {
    user: {
      ...toPublic({ ...user, organization: org }),
      isEmailVerified: false,
      organizationName: org.name,
    },
    tokens,
    emailSent,
  };
}

/** Verifies the confirmation token, marks user email as verified, and returns an authenticated session. */
async function confirmEmail({ token, ip }) {
  if (!token) {
    throw new BadRequest('INVALID_TOKEN', 'Email confirmation token is required.');
  }

  const tokenHash = hashToken(token);
  const record = await emailConfirmationTokenModel.findByHash(tokenHash);

  if (!record || record.confirmedAt || record.expiresAt <= new Date() || !record.user?.isActive) {
    throw new BadRequest('INVALID_OR_EXPIRED_TOKEN', 'This email confirmation link is invalid or has expired.');
  }

  const updatedUser = await prisma.$transaction(async (tx) => {
    await emailConfirmationTokenModel.markConfirmed(record.id, tx);
    await emailConfirmationTokenModel.invalidateAllForUser(record.userId, tx);
    return userModel.update(record.userId, { isEmailVerified: true }, tx);
  });

  await authCache.invalidate(record.userId);

  await audit.record({
    userId: record.userId,
    action: 'auth.email_confirmed',
    entity: 'user',
    entityId: record.userId,
    details: { email: record.user.email },
    ip,
  });

  const tokens = await issueSession(updatedUser);

  return {
    message: 'Email confirmed successfully. You can now access your workspace onboarding.',
    user: toPublic(updatedUser),
    tokens,
  };
}

/** Resends an email confirmation link to an unverified user. */
async function resendConfirmationEmail({ email, ip }) {
  const genericMessage = 'If an unconfirmed account exists with that email address, a confirmation email has been sent.';
  if (!email) {
    throw new BadRequest('INVALID_EMAIL', 'Email address is required.');
  }

  const cleanEmail = email.toLowerCase().trim();
  const user = await userModel.findByEmailWithHash(cleanEmail);

  if (!user || !user.isActive) {
    return { message: genericMessage };
  }

  if (user.isEmailVerified) {
    return {
      message: 'Your email address is already confirmed. You can log in directly.',
      alreadyVerified: true,
    };
  }

  // Invalidate any prior unused confirmation tokens
  await emailConfirmationTokenModel.invalidateAllForUser(user.id);

  // Generate new 24h token
  const confirmationToken = randomToken();
  const tokenHash = hashToken(confirmationToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await emailConfirmationTokenModel.create({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const confirmUrl = `${appUrl}/confirm-email?token=${encodeURIComponent(confirmationToken)}`;

  try {
    await emailService.sendRegistrationConfirmationEmail({
      to: user.email,
      userName: user.name,
      role: user.role,
      confirmUrl,
      loginUrl: `${appUrl}/login`,
      expiresInHours: 24,
    });
  } catch (err) {
    logger.error({ err, email: user.email }, 'Failed to resend confirmation email');
    throw new BadRequest('EMAIL_SEND_FAILED', 'Failed to send confirmation email. Please try again later.');
  }

  await audit.record({
    userId: user.id,
    action: 'auth.resend_confirmation',
    entity: 'user',
    entityId: user.id,
    details: { email: user.email },
    ip,
  });

  return { message: 'A new confirmation email has been sent to your inbox.' };
}

/** Accepts an invitation, sets the new member's password, and activates their session. */
async function acceptInvite({ token, name, password, ip }) {
  if (!token) throw new BadRequest('INVITE_TOKEN_REQUIRED', 'Invitation token is required.');
  const user = await userModel.findByInviteToken(token);
  if (!user || user.inviteAcceptedAt) {
    throw new BadRequest('INVALID_INVITE_TOKEN', 'This invitation link is invalid or has already been accepted.');
  }

  const passwordHash = await hashPassword(password);
  const updated = await userModel.update(user.id, {
    passwordHash,
    ...(name && { name: name.trim() }),
    inviteAcceptedAt: new Date(),
    inviteToken: null,
    isEmailVerified: true,
    lastLoginAt: new Date(),
  });

  const tokens = await issueSession(updated);

  await audit.record({
    userId: updated.id,
    action: 'auth.invite_accepted',
    entity: 'user',
    entityId: updated.id,
    details: { email: updated.email, role: updated.role, organizationId: updated.organizationId },
    ip,
  });

  // Notify teammates who opted into colleague joined alerts
  if (updated.organizationId) {
    prisma.user
      .findMany({
        where: {
          organizationId: updated.organizationId,
          id: { not: updated.id },
          isActive: true,
          notifyTeamChanges: true,
        },
        select: { email: true, name: true },
      })
      .then(async (teammates) => {
        const orgRow = await organizationModel.findById(updated.organizationId);
        const orgName = orgRow?.name || 'Workspace';
        const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
        for (const t of teammates) {
          emailService
            .sendColleagueJoinedEmail({
              to: t.email,
              userName: t.name,
              newMemberName: updated.name,
              newMemberEmail: updated.email,
              newMemberRole: updated.role,
              newMemberTitle: updated.roleTitle,
              organizationName: orgName,
              teamUrl: `${appUrl}/users`,
            })
            .catch((err) => {
              logger.warn({ err: err.message, to: t.email }, 'Failed sending colleague joined alert email');
            });
        }
      })
      .catch((err) => {
        logger.warn({ err: err.message }, 'Failed querying teammates for colleague joined alert');
      });
  }

  return { user: toPublic(updated), tokens };
}

module.exports = {
  hashPassword,
  endAllSessions,
  register,
  confirmEmail,
  resendConfirmationEmail,
  acceptInvite,
  login,
  refresh,
  logout,
  changePassword,
  updateProfile,
  forgotPassword,
  verifyResetToken,
  resetPassword,
};
