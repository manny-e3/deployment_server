const { Router } = require('express');
const projects = require('../controllers/projects.controller');
const deployments = require('../controllers/deployments.controller');
const authenticate = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const validate = require('../middlewares/validate');
const {
  createProjectBody,
  createTargetBody,
  deployBody,
  idParams,
  paginationQuery,
  targetParams,
  updateProjectBody,
  updateTargetBody,
} = require('../utils/schemas');

const router = Router();

router.use(authenticate);

const view = authorize('projects:view');
const manage = authorize('projects:manage');
const byId = validate({ params: idParams });

router.get('/', view, validate({ query: paginationQuery }), projects.list);
router.post('/', manage, validate({ body: createProjectBody }), projects.create);
router.get('/:id', view, byId, projects.get);
router.patch('/:id', manage, validate({ params: idParams, body: updateProjectBody }), projects.update);
router.delete('/:id', manage, byId, projects.remove);
router.post('/:id/webhook-secret', manage, byId, projects.regenerateWebhookSecret);
router.post(
  '/:id/deploy',
  authorize('deploy:create'),
  validate({ params: idParams, body: deployBody }),
  deployments.start,
);

router.post(
  '/:id/targets',
  manage,
  validate({ params: idParams, body: createTargetBody }),
  projects.createTarget,
);
router.patch(
  '/:id/targets/:targetId',
  manage,
  validate({ params: targetParams, body: updateTargetBody }),
  projects.updateTarget,
);
router.delete(
  '/:id/targets/:targetId',
  manage,
  validate({ params: targetParams }),
  projects.removeTarget,
);

module.exports = router;
