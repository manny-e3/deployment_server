const { Router } = require('express');
const auditLogs = require('../controllers/auditLogs.controller');
const authenticate = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const validate = require('../middlewares/validate');
const { auditQuery } = require('../utils/schemas');

const router = Router();

// GET /audit-logs?userId=&action=deploy.*&entity=&entityId=&from=&to=&limit=&cursor=
router.get('/', authenticate, authorize('audit:view'), validate({ query: auditQuery }), auditLogs.list);

module.exports = router;
