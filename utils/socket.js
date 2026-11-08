// Socket.IO server: pushes live deploy logs and status to browsers.
// The worker publishes to Redis; this relays each message to the matching room.
//
// Client -> server:  deployment:join / deployment:leave { id },  project:join / project:leave { id }
// Server -> client:  deployment:logs, deployment:status, project:status
const { Server } = require('socket.io');
const { resolveSession } = require('../middlewares/authenticate');
const { ACCESS_COOKIE } = require('./cookies');
const { env } = require('./env');
const { logger } = require('./logger');
const { can } = require('./permissions');
const { createRedisConnection } = require('./redis');
const prisma = require('../models/prisma');

const ID = /^c[a-z0-9]{8,}$/i;

function readCookie(header = '', name) {
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function createSocketServer(httpServer) {
    const allowedOrigins = [
    env.APP_URL,
    env.FRONTEND_URL,
    'https://portalops.online',
    'https://www.portalops.online',
    'http://portalops.online',
    'http://www.portalops.online',
    'https://deploy.travaiq.com',
    'http://localhost:5173',
    'http://localhost:3000',
  ].filter(Boolean);

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    },
  });

  // The handshake carries the browser's cookies or auth.token payload; the same session check as the HTTP API.
  io.use(async (socket, next) => {
    try {
      const authHeader = socket.handshake.headers.authorization;
      const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const authToken = socket.handshake.auth?.token;
      const cookieToken = readCookie(socket.handshake.headers.cookie, ACCESS_COOKIE);
      const token = authToken || bearer || cookieToken;
      socket.data.user = await resolveSession(token);
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const allowed = can(socket.data.user.role, 'deployments:view');

    for (const kind of ['deployment', 'project']) {
      socket.on(`${kind}:join`, async (payload, ack) => {
        const id = payload?.id;
        if (!allowed || typeof id !== 'string' || !ID.test(id)) return ack?.({ ok: false });

        const userOrg = socket.data.user?.organizationId;
        if (!userOrg) return ack?.({ ok: false });

        // Verify tenant ownership before subscribing socket to room
        try {
          if (kind === 'project') {
            const exists = await prisma.project.findFirst({
              where: { id, organizationId: userOrg },
              select: { id: true },
            });
            if (!exists) return ack?.({ ok: false, error: 'NOT_FOUND' });
          } else if (kind === 'deployment') {
            const exists = await prisma.deployment.findFirst({
              where: { id, target: { project: { organizationId: userOrg } } },
              select: { id: true },
            });
            if (!exists) return ack?.({ ok: false, error: 'NOT_FOUND' });
          }
        } catch (err) {
          logger.warn({ err, kind, id }, 'Socket room tenant check error');
          return ack?.({ ok: false });
        }

        socket.join(`${kind}:${id}`);
        ack?.({ ok: true });
      });

      socket.on(`${kind}:leave`, (payload, ack) => {
        const id = payload?.id;
        if (typeof id === 'string' && ID.test(id)) {
          socket.leave(`${kind}:${id}`);
          ack?.({ ok: true });
        } else {
          ack?.({ ok: false });
        }
      });
    }
  });

  // One Redis connection subscribed to every deploy and project channel.
  const subscriber = createRedisConnection('socket-relay');
  subscriber.psubscribe('deploy:*', 'project:*').catch((err) =>
    logger.error({ err }, 'subscribing to deploy events failed'),
  );
  subscriber.on('pmessage', (_pattern, channel, message) => {
    const [kind, id, topic] = channel.split(':');
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if (kind === 'deploy' && topic === 'logs') io.to(`deployment:${id}`).emit('deployment:logs', payload);
    else if (kind === 'deploy' && topic === 'status') io.to(`deployment:${id}`).emit('deployment:status', payload);
    else if (kind === 'project' && topic === 'status') io.to(`project:${id}`).emit('project:status', payload);
  });

  const close = async () => {
    await new Promise((resolve) => io.close(() => resolve()));
    await subscriber.quit().catch(() => {});
  };

  return { io, close };
}

module.exports = { createSocketServer };
