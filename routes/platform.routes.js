const { Router } = require('express');
const authenticate = require('../middlewares/authenticate');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin');
const platformController = require('../controllers/platform.controller');

const router = Router();

// Enforce authentication & Super Admin role across all platform routes
router.use(authenticate);
router.use(requireSuperAdmin);

// Platform Overview & Metrics
router.get('/overview', platformController.overview);

// Organization / Tenant Management
router.get('/organizations', platformController.listOrganizations);
router.post('/organizations', platformController.createOrganization);
router.patch('/organizations/:id/status', platformController.toggleOrganizationStatus);

// Global User Management
router.get('/users', platformController.listUsers);
router.patch('/users/:id/status', platformController.toggleUserStatus);
router.patch('/users/:id/super-admin', platformController.toggleUserSuperAdmin);

// Cross-tenant Deployments Telemetry
router.get('/deployments', platformController.listDeployments);

// System Health & Engine Telemetry
router.get('/system-health', platformController.getSystemHealth);

// Backup & Disaster Recovery
router.get('/backups', platformController.listBackups);
router.post('/backup', platformController.triggerBackup);

// Global Audit Logs
router.get('/audit-logs', platformController.listAuditLogs);

module.exports = router;

