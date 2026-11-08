const authService = require('../services/auth.service');
const emailService = require('../services/email.service');
const userModel = require('../models/user.model');
const { loginLimiter, registerLimiter } = require('../middlewares/rateLimit');
const { REFRESH_COOKIE, clearSessionCookies, setSessionCookies } = require('../utils/cookies');

exports.register = async (req, res) => {
  const { name, email, password, organizationName, role } = req.body;
  const { user, tokens, emailSent } = await authService.register({
    name,
    email,
    password,
    organizationName,
    role,
    ip: req.ip,
  });
  await registerLimiter.reset(req);
  const csrfToken = setSessionCookies(res, tokens);
  res.status(201).json({
    ...user,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    csrfToken,
    emailSent,
  });
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const { user, tokens } = await authService.login({ email, password, ip: req.ip });
  await loginLimiter.reset(req);
  const csrfToken = setSessionCookies(res, tokens);
  res.json({
    ...user,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    csrfToken,
  });
};

exports.refresh = async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
    const { user, tokens } = await authService.refresh({
      refreshToken,
      ip: req.ip,
    });
    const csrfToken = setSessionCookies(res, tokens);
    res.json({
      ...user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      csrfToken,
    });
  } catch (err) {
    clearSessionCookies(res);
    throw err;
  }
};

exports.logout = async (req, res) => {
  const refreshToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
  await authService.logout({ refreshToken, ip: req.ip });
  clearSessionCookies(res);
  res.status(204).end();
};

exports.me = async (req, res) => {
  const user = await userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
  res.json({
    ...user,
    organizationName: user.organization?.name || 'Primary Workspace',
  });
};

exports.changePassword = async (req, res) => {
  const tokens = await authService.changePassword({
    userId: req.user.id,
    currentPassword: req.body.currentPassword,
    newPassword: req.body.newPassword,
    ip: req.ip,
  });
  const csrfToken = setSessionCookies(res, tokens);
  res.json({
    message: 'Password updated successfully.',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    csrfToken,
  });
};

exports.updateProfile = async (req, res) => {
  const updated = await authService.updateProfile({
    userId: req.user.id,
    name: req.body.name,
    roleTitle: req.body.roleTitle,
    notifyDeployFailures: req.body.notifyDeployFailures,
    notifyDeploySuccess: req.body.notifyDeploySuccess,
    notifyTeamChanges: req.body.notifyTeamChanges,
    ip: req.ip,
  });
  res.json(updated);
};

exports.forgotPassword = async (req, res) => {
  const result = await authService.forgotPassword({
    email: req.body.email,
    ip: req.ip,
  });
  res.json(result);
};

exports.verifyResetToken = async (req, res) => {
  const result = await authService.verifyResetToken({
    token: req.query.token,
  });
  res.json(result);
};

exports.resetPassword = async (req, res) => {
  const result = await authService.resetPassword({
    token: req.body.token,
    newPassword: req.body.newPassword,
    ip: req.ip,
  });
  res.json(result);
};

exports.confirmEmail = async (req, res) => {
  const token = req.body?.token || req.query?.token;
  const result = await authService.confirmEmail({
    token,
    ip: req.ip,
  });
  const csrfToken = setSessionCookies(res, result.tokens);
  res.json({
    ...result.user,
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    csrfToken,
    message: result.message,
  });
};

exports.resendConfirmation = async (req, res) => {
  const result = await authService.resendConfirmationEmail({
    email: req.body.email,
    ip: req.ip,
  });
  res.json(result);
};

exports.acceptInvite = async (req, res) => {
  const result = await authService.acceptInvite({
    token: req.body.token,
    name: req.body.name,
    password: req.body.password,
    ip: req.ip,
  });
  const csrfToken = setSessionCookies(res, result.tokens);
  res.json({
    ...result.user,
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    csrfToken,
    message: 'Invitation accepted successfully.',
  });
};

exports.sendTestAlert = async (req, res) => {
  const { alertType = 'DEPLOYMENT_SUCCESS' } = req.body || {};
  const user = req.user;

  if (alertType === 'DEPLOYMENT_FAILURE') {
    await emailService.sendDeploymentStatusEmail({
      to: user.email,
      userName: user.name,
      projectName: 'demo-api-service',
      targetName: 'Production Target (H Server)',
      serverHost: '62.72.37.221',
      status: 'FAILED',
      branch: 'main',
      commitSha: '9f0bb85a1b2c3d4e5f67890123456789abcdef12',
      commitMessage: 'fix(api): Test failure alert dispatch',
      error: 'Health check probe timeout: HTTP 504 Gateway Timeout after 5 attempts',
      durationSec: 42,
    });
  } else if (alertType === 'TEAM_JOINED') {
    await emailService.sendColleagueJoinedEmail({
      to: user.email,
      userName: user.name,
      newMemberName: 'Sarah Connor',
      newMemberEmail: 'sarah.connor@example.com',
      newMemberRole: 'DEPLOYER',
      newMemberTitle: 'DevOps Specialist',
      organizationName: user.organizationName || 'Primary Workspace',
    });
  } else {
    await emailService.sendDeploymentStatusEmail({
      to: user.email,
      userName: user.name,
      projectName: 'portalops-web',
      targetName: 'Production Target (H Server)',
      serverHost: '62.72.37.221',
      status: 'SUCCESS',
      branch: 'main',
      commitSha: 'dc67938a1b2c3d4e5f67890123456789abcdef12',
      commitMessage: 'feat(release): Verified production deployment',
      durationSec: 28,
    });
  }

  res.json({ message: `Test ${alertType} email dispatched to ${user.email}. Check your inbox!` });
};
