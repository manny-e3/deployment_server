const { Router } = require('express');
const deployments = require('../controllers/deployments.controller');
const authenticate = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const validate = require('../middlewares/validate');
const { idParams, listDeploymentsQuery, logsQuery } = require('../utils/schemas');

const router = Router();

router.use(authenticate);

const view = authorize('deployments:view');
const byId = validate({ params: idParams });

router.get('/', view, validate({ query: listDeploymentsQuery }), deployments.list);
router.get('/:id', view, byId, deployments.get);
router.get('/:id/logs', view, validate({ params: idParams, query: logsQuery }), deployments.logs);
router.post('/:id/cancel', authorize('deploy:cancel'), byId, deployments.cancel);
router.post('/:id/rollback', authorize('deploy:rollback'), byId, deployments.rollback);

module.exports = router;
