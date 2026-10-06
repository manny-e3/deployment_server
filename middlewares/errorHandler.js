const { Prisma } = require('@prisma/client');
const { AppError, BadRequest, Conflict, NotFound } = require('../utils/errors');
const { logger } = require('../utils/logger');

// Turns anything thrown into an AppError. Unknown errors become a generic 500.
function toAppError(err) {
  if (err instanceof AppError) return err;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return new Conflict('ALREADY_EXISTS', 'A record with this value already exists', {
        fields: err.meta?.target,
      });
    }
    if (err.code === 'P2025') return new NotFound('Record');
  }

  // Errors from express.json()
  if (err?.type === 'entity.parse.failed') {
    return new BadRequest('INVALID_JSON', 'The request body is not valid JSON');
  }
  if (err?.type === 'entity.too.large') {
    return new AppError('PAYLOAD_TOO_LARGE', 413, 'The request body is larger than 1 MB');
  }

  return new AppError(
    'INTERNAL_ERROR',
    500,
    'Something went wrong. Quote the request id when reporting this.',
  );
}

// The stack of a 500 is logged, never sent.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const appError = toAppError(err);
  if (appError.status >= 500) (req.log ?? logger).error({ err }, 'unhandled error');

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details && { details: appError.details }),
    },
  });
}

module.exports = errorHandler;
module.exports.toAppError = toAppError;
