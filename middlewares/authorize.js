const { Forbidden } = require('../utils/errors');
const { can } = require('../utils/permissions');

// Use after authenticate: router.post('/', authenticate, authorize('users:manage'), ...)
const authorize = (action) => (req, _res, next) => {
  next(can(req.user?.role, action) ? undefined : new Forbidden());
};

module.exports = authorize;
