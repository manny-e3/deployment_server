const { Forbidden } = require('../utils/errors');

/**
 * Ensures the authenticated user has platform-level Super Admin privileges.
 */
function requireSuperAdmin(req, _res, next) {
  if (req.user?.isSuperAdmin === true || req.user?.role === 'SUPER_ADMIN') {
    return next();
  }
  return next(new Forbidden('Platform Super Admin privileges required'));
}

module.exports = requireSuperAdmin;

