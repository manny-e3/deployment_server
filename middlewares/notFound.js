const { AppError } = require('../utils/errors');

module.exports = (req, _res, next) => {
  next(new AppError('ROUTE_NOT_FOUND', 404, `No route for ${req.method} ${req.path}`));
};
