const { Router } = require('express');
const servers = require('../controllers/servers.controller');
const authenticate = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const validate = require('../middlewares/validate');
const {
  createServerBody,
  idParams,
  paginationQuery,
  updateServerBody,
} = require('../utils/schemas');

const router = Router();

router.use(authenticate);

const view = authorize('servers:view');
const manage = authorize('servers:manage');
const byId = validate({ params: idParams });

router.get('/', view, validate({ query: paginationQuery }), servers.list);
router.post('/', manage, validate({ body: createServerBody }), servers.create);
router.get('/:id', view, byId, servers.get);
router.patch('/:id', manage, validate({ params: idParams, body: updateServerBody }), servers.update);
router.delete('/:id', manage, byId, servers.remove);
router.post('/:id/test', manage, byId, servers.test);
router.post('/:id/reset-fingerprint', manage, byId, servers.resetFingerprint);

module.exports = router;
