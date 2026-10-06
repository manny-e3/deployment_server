const authService = require('../services/auth.service');
const userModel = require('../models/user.model');
const { loginLimiter } = require('../middlewares/rateLimit');
const { REFRESH_COOKIE, clearSessionCookies, setSessionCookies } = require('../utils/cookies');

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const { user, tokens } = await authService.login({ email, password, ip: req.ip });
  await loginLimiter.reset(req);
  setSessionCookies(res, tokens);
  res.json(user);
};

exports.refresh = async (req, res) => {
  try {
    const { user, tokens } = await authService.refresh({
      refreshToken: req.cookies?.[REFRESH_COOKIE],
      ip: req.ip,
    });
    setSessionCookies(res, tokens);
    res.json(user);
  } catch (err) {
    clearSessionCookies(res);
    throw err;
  }
};

exports.logout = async (req, res) => {
  await authService.logout({ refreshToken: req.cookies?.[REFRESH_COOKIE], ip: req.ip });
  clearSessionCookies(res);
  res.status(204).end();
};

exports.me = async (req, res) => {
  res.json(await userModel.findById(req.user.id));
};

exports.changePassword = async (req, res) => {
  const tokens = await authService.changePassword({
    userId: req.user.id,
    currentPassword: req.body.currentPassword,
    newPassword: req.body.newPassword,
    ip: req.ip,
  });
  setSessionCookies(res, tokens);
  res.status(204).end();
};
