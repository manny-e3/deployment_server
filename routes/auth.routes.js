const { Router } = require('express');
const auth = require('../controllers/auth.controller');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const { loginLimiter, forgotPasswordLimiter } = require('../middlewares/rateLimit');
const { changePasswordBody, loginBody, forgotPasswordBody, resetPasswordBody } = require('../utils/schemas');

const router = Router();

router.post('/login', validate({ body: loginBody }), loginLimiter, auth.login);
router.post('/refresh', auth.refresh);
router.post('/logout', auth.logout);
router.post('/forgot-password', validate({ body: forgotPasswordBody }), forgotPasswordLimiter, auth.forgotPassword);
router.get('/verify-reset-token', auth.verifyResetToken);
router.post('/reset-password', validate({ body: resetPasswordBody }), auth.resetPassword);
router.get('/me', authenticate, auth.me);
router.patch('/password', authenticate, validate({ body: changePasswordBody }), auth.changePassword);

module.exports = router;
