const { Router } = require('express');
const csrf = require('../middlewares/csrf');
const { apiLimiter } = require('../middlewares/rateLimit');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const userRoutes = require('./users.routes');
const serverRoutes = require('./servers.routes');
const projectRoutes = require('./projects.routes');
const targetRoutes = require('./targets.routes');
const deploymentRoutes = require('./deployments.routes');
const auditLogRoutes = require('./auditLogs.routes');

// Everything here is served under /api/v1. Webhooks are mounted separately in index.js.
const router = Router();

router.use('/health', healthRoutes);

// Below this line: 300 requests per minute per user, and every write request needs the
// X-CSRF-Token header (login excepted).
router.use(apiLimiter);
router.use(csrf);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/servers', serverRoutes);
router.use('/projects', projectRoutes);
router.use('/targets', targetRoutes);
router.use('/deployments', deploymentRoutes);
router.use('/audit-logs', auditLogRoutes);

module.exports = router;
