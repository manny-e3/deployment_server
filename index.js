const cookieParser = require('cookie-parser');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const { env } = require('./utils/env');
const { logger } = require('./utils/logger');
const { closeConnections } = require('./utils/connections');
const { createSocketServer } = require('./utils/socket');
const requestId = require('./middlewares/requestId');
const httpLogger = require('./middlewares/httpLogger');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const routes = require('./routes');
const webhookRoutes = require('./routes/webhooks.routes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // Nginx runs on the same host

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());
  // Only the portal's own frontend may call the API from a browser.
  app.use(cors({ origin: env.APP_URL, credentials: true }));
  app.use(cookieParser());

  // Webhooks need the exact raw body to check the signature, so they come before express.json().
  app.use('/api/v1/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), webhookRoutes);

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

function start() {
  const server = createApp().listen(env.PORT, (err) => {
    if (err) {
      logger.fatal({ err }, 'API failed to start');
      process.exit(1);
    }
    logger.info(`API listening on http://localhost:${env.PORT}`);
  });
  const sockets = createSocketServer(server);

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    sockets.close();
    server.close(async () => {
      await closeConnections();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// `node index.js` starts the server; tests require this file and use createApp() directly.
if (require.main === module) start();

module.exports = { createApp };
