const crypto = require('node:crypto');
const prisma = require('../models/prisma');
const userModel = require('../models/user.model');
const organizationModel = require('../models/organization.model');
const refreshTokenModel = require('../models/refreshToken.model');
const emailService = require('./email.service');
const audit = require('./audit.service');
const { hashPassword } = require('./auth.service');
const authCache = require('../utils/authCache');
const { randomToken } = require('../utils/tokens');
const { env } = require('../utils/env');
const { logger } = require('../utils/logger');
const { BusinessRuleError, Conflict, NotFound } = require('../utils/errors');

const list = (query, actor) => {
  if (actor?.organizationId) {
    return userModel.list({
      ...query,
      organizationId: actor.organizationId,
    });
  }
  return userModel.list(query);
};

async function get(id, actor) {
  const user = await userModel.findById(id);
  if (!user) throw new NotFound('User');
  if (actor?.organizationId && user.organizationId && user.organizationId !== actor.organizationId) {
    throw new NotFound('User');
  }
  return user;
}

/** Creates a user with a random temporary password, returned only in this response. */
async function create({ name, email, role }, actor, ip) {
  const temporaryPassword = crypto.randomBytes(12).toString('base64url'); // 16 characters
  const user = await userModel.create({
    name,
    email,
    role,
    organizationId: actor?.organizationId || null,
    passwordHash: await hashPassword(temporaryPassword),
  });

  await audit.record({
    userId: actor.id,
    action: 'user.created',
    entity: 'user',
    entityId: user.id,
    details: { email, role },
    ip,
  });
  return { user, temporaryPassword };
}

/**
 * Changes name, role or active flag. Changing the role or deactivating a user logs them out
 * everywhere at once. Admins cannot change their own role or deactivate themselves.
 */
async function update(id, changes, actor, ip, action = 'user.updated') {
  const changesOwnAccess =
    (changes.role !== undefined && changes.role !== actor.role) || changes.isActive === false;
  if (id === actor.id && changesOwnAccess) {
    throw new BusinessRuleError(
      'CANNOT_CHANGE_OWN_ACCESS',
      'You cannot change your own role or deactivate yourself',
    );
  }

  const before = await get(id, actor);
  const diff = Object.fromEntries(
    Object.entries(changes)
      .filter(([field, value]) => before[field] !== value)
      .map(([field, value]) => [field, { from: before[field], to: value }]),
  );
  if (Object.keys(diff).length === 0) return before;

  const endsSessions = 'role' in diff || diff.isActive?.to === false;
  const updated = await prisma.$transaction(async (tx) => {
    if (endsSessions) await refreshTokenModel.revokeAllForUser(id, tx);
    return userModel.update(
      id,
      { ...changes, ...(endsSessions && { tokenVersion: { increment: 1 } }) },
      tx,
    );
  });
  await authCache.invalidate(id);

  await audit.record({ userId: actor.id, action, entity: 'user', entityId: id, details: diff, ip });
  const { tokenVersion: _tokenVersion, ...user } = updated;
  return user;
}

/** Invites a new team member and dispatches an invitation email with an acceptance link. */
async function invite({ name, email, role = 'DEPLOYER', roleTitle }, actor, ip) {
  const cleanEmail = email.toLowerCase().trim();
  const existing = await userModel.findByEmailWithHash(cleanEmail);

  const org = actor?.organizationId ? await organizationModel.findById(actor.organizationId) : null;
  const orgName = org?.name || 'PortalOps Workspace';
  const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const token = randomToken();

  let user;
  if (existing) {
    if (existing.organizationId === actor.organizationId && existing.inviteToken) {
      // Re-invite existing pending member
      user = await userModel.update(existing.id, {
        inviteToken: token,
        invitedAt: new Date(),
        role: role.toUpperCase(),
        ...(roleTitle && { roleTitle: roleTitle.trim() }),
      });
    } else if (existing.organizationId === actor.organizationId) {
      throw new Conflict('USER_ALREADY_EXISTS', 'This user is already an active member of your team.');
    } else {
      throw new Conflict('EMAIL_EXISTS', 'An account with this email address already exists on the platform.');
    }
  } else {
    const temporaryPassword = crypto.randomBytes(12).toString('base64url');
    user = await userModel.create({
      name: name?.trim() || cleanEmail.split('@')[0],
      email: cleanEmail,
      role: role.toUpperCase(),
      roleTitle: roleTitle?.trim() || null,
      organizationId: actor?.organizationId || null,
      inviteToken: token,
      invitedAt: new Date(),
      isActive: true,
      isEmailVerified: false,
      passwordHash: await hashPassword(temporaryPassword),
    });
  }

  const inviteUrl = `${appUrl}/accept-invite?token=${encodeURIComponent(token)}&email=${encodeURIComponent(cleanEmail)}&role=${encodeURIComponent(user.role)}&org=${encodeURIComponent(orgName)}&inviter=${encodeURIComponent(actor.name || 'Team Admin')}`;

  let emailSent = false;
  try {
    await emailService.sendTeamInvitationEmail({
      to: cleanEmail,
      memberName: user.name,
      inviterName: actor.name || 'Team Admin',
      organizationName: orgName,
      role: user.role,
      roleTitle: user.roleTitle,
      inviteUrl,
    });
    emailSent = true;
  } catch (err) {
    logger.error({ err, email: cleanEmail }, 'Failed to dispatch team invitation email');
  }

  await audit.record({
    userId: actor.id,
    action: 'user.invited',
    entity: 'user',
    entityId: user.id,
    details: { email: cleanEmail, role: user.role, roleTitle: user.roleTitle, emailSent },
    ip,
  });

  return { user, inviteLink: inviteUrl, emailSent };
}

/** Resends the invitation email to a pending team member. */
async function resendInvite({ email }, actor, ip) {
  const cleanEmail = email.toLowerCase().trim();
  const existing = await userModel.findByEmailAndOrg(cleanEmail, actor?.organizationId);
  if (!existing || !existing.inviteToken) {
    throw new NotFound('Pending invitation for this user was not found');
  }

  const org = actor?.organizationId ? await organizationModel.findById(actor.organizationId) : null;
  const orgName = org?.name || 'PortalOps Workspace';
  const appUrl = (env.FRONTEND_URL || env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const token = randomToken();

  const user = await userModel.update(existing.id, {
    inviteToken: token,
    invitedAt: new Date(),
  });

  const inviteUrl = `${appUrl}/accept-invite?token=${encodeURIComponent(token)}&email=${encodeURIComponent(cleanEmail)}&role=${encodeURIComponent(user.role)}&org=${encodeURIComponent(orgName)}&inviter=${encodeURIComponent(actor.name || 'Team Admin')}`;

  let emailSent = false;
  try {
    await emailService.sendTeamInvitationEmail({
      to: cleanEmail,
      memberName: user.name,
      inviterName: actor.name || 'Team Admin',
      organizationName: orgName,
      role: user.role,
      roleTitle: user.roleTitle,
      inviteUrl,
    });
    emailSent = true;
  } catch (err) {
    logger.error({ err, email: cleanEmail }, 'Failed to resend team invitation email');
  }

  await audit.record({
    userId: actor.id,
    action: 'user.invite_resent',
    entity: 'user',
    entityId: user.id,
    details: { email: cleanEmail, emailSent },
    ip,
  });

  return { success: true, inviteLink: inviteUrl, emailSent };
}

/** Deactivates an active user or revokes a pending invitation. */
async function deactivate(id, actor, ip) {
  const user = await get(id, actor);
  if (user.inviteToken && !user.inviteAcceptedAt) {
    await prisma.user.delete({ where: { id } });
    await audit.record({
      userId: actor.id,
      action: 'user.invite_revoked',
      entity: 'user',
      entityId: id,
      details: { email: user.email },
      ip,
    });
    return;
  }
  return update(id, { isActive: false }, actor, ip, 'user.deactivated');
}

module.exports = { list, get, create, invite, resendInvite, update, deactivate };
