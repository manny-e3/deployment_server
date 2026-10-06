// Public, but every request must carry a valid signature (GitHub) or token (GitLab).
// Mounted in index.js before express.json(), with express.raw(), because the signature is
// computed over the exact bytes GitHub sent.
const { Router } = require('express');
const webhooks = require('../controllers/webhooks.controller');
const { rateLimit } = require('../middlewares/rateLimit');

const router = Router();

// 60 deliveries per minute per project, checked before the signature.
const perProject = rateLimit({
  name: 'webhook',
  limit: 60,
  windowSec: 60,
  key: (req) => req.params.projectId,
});

router.post('/github/:projectId', perProject, webhooks.github);
router.post('/gitlab/:projectId', perProject, webhooks.gitlab);

module.exports = router;
