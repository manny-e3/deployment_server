const crypto = require('node:crypto');
const prisma = require('../models/prisma');
const userModel = require('../models/user.model');
const refreshTokenModel = require('../models/refreshToken.model');
const audit = require('./audit.service');
const { hashPassword } = require('./auth.service');
const authCache = require('../utils/authCache');
const { BusinessRuleError, NotFound } = require('../utils/errors');

const list = (query) => userModel.list(query);

async function get(id) {
  const user = await userModel.findById(id);
  if (!user) throw new NotFound('User');
  return user;
}

/** Creates a user with a random temporary password, returned only in this response. */
async function create({ name, email, role }, actor, ip) {
  const temporaryPassword = crypto.randomBytes(12).toString('base64url'); // 16 characters
  const user = await userModel.create({
    name,
    email,
    role,
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

  const before = await get(id);
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

// DELETE /users/:id deactivates; user rows are never deleted, so history stays intact.
const deactivate = (id, actor, ip) => update(id, { isActive: false }, actor, ip, 'user.deactivated');

module.exports = { list, get, create, update, deactivate };
