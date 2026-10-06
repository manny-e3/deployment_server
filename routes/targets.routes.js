const { Router } = require('express');
const targets = require('../controllers/targets.controller');
const authenticate = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const validate = require('../middlewares/validate');
const { idParams, putEnvBody } = require('../utils/schemas');

const router = Router();

// Env vars and DB tools are admin-only
router.use(authenticate, authorize('projects:manage'));

router.get('/:id/env', validate({ params: idParams }), targets.getEnv);
router.get('/:id/env-full', validate({ params: idParams }), targets.getEnvFull);
router.put('/:id/env', validate({ params: idParams, body: putEnvBody }), targets.putEnv);
router.post('/:id/import-sql', validate({ params: idParams }), targets.importSql);
router.post('/:id/artisan', validate({ params: idParams }), targets.runArtisan);

module.exports = router;
