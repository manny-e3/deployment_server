const auditLogModel = require('../models/auditLog.model');
const { logger } = require('../utils/logger');

/**
 * Writes one audit entry, e.g.
 * record({ userId, action: 'user.created', entity: 'user', entityId, details, ip }).
 * A failed write is logged as an error but never undoes the action it describes.
 */
async function record({ userId = null, action, entity, entityId = null, details, ip = null }) {
  try {
    await auditLogModel.create({ userId, action, entity, entityId, details, ip });
  } catch (err) {
    logger.error({ err, action, entity, entityId }, 'audit write failed');
  }
}

module.exports = { record };
