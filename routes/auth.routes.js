const { Router } = require('express');
const auth = require('../controllers/auth.controller');
const authenticate = require('../middlewares/authenticate');
const validate = require('../middlewares/validate');
const { loginLimiter, registerLimiter, forgotPasswordLimiter } = require('../middlewares/rateLimit');
const {
  changePasswordBody,
  updateProfileBody,
  loginBody,
  registerBody,
  confirmEmailBody,
  resendConfirmationBody,
  acceptInviteBody,
  forgotPasswordBody,
  resetPasswordBody,
} = require('../utils/schemas');

const router = Router();

router.post('/register', validate({ body: registerBody }), registerLimiter, auth.register);
router.post('/confirm-email', auth.confirmEmail);
router.get('/confirm-email', auth.confirmEmail);
router.post('/resend-confirmation', validate({ body: resendConfirmationBody }), auth.resendConfirmation);
router.post('/accept-invite', validate({ body: acceptInviteBody }), auth.acceptInvite);
router.post('/login', validate({ body: loginBody }), loginLimiter, auth.login);
router.post('/refresh', auth.refresh);
router.post('/logout', auth.logout);
router.post('/forgot-password', validate({ body: forgotPasswordBody }), forgotPasswordLimiter, auth.forgotPassword);
router.get('/verify-reset-token', auth.verifyResetToken);
router.post('/reset-password', validate({ body: resetPasswordBody }), auth.resetPassword);
router.get('/me', authenticate, auth.me);
router.patch('/profile', authenticate, validate({ body: updateProfileBody }), auth.updateProfile);
router.patch('/password', authenticate, validate({ body: changePasswordBody }), auth.changePassword);
router.post('/test-alert', authenticate, auth.sendTestAlert);

module.exports = router;
