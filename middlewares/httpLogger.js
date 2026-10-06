const { pinoHttp } = require('pino-http');
const { logger } = require('../utils/logger');

// Logs one line per request, tagged with the request id.
module.exports = pinoHttp({
  logger,
  genReqId: (req) => req.id,
  customLogLevel: (_req, res, err) =>
    err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
});
