const { Router } = require('express');
const auth = require('../controllers/auth.controller');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const { loginLimiter } = require('../middlewares/rateLimit');
const { changePasswordBody, loginBody } = require('../utils/schemas');

const router = Router();

router.post('/login', validate({ body: loginBody }), loginLimiter, auth.login);
router.post('/refresh', auth.refresh);
router.post('/logout', auth.logout);
router.get('/me', authenticate, auth.me);
router.patch('/password', authenticate, validate({ body: changePasswordBody }), auth.changePassword);

module.exports = router;
