const userService = require('../services/user.service');

exports.list = async (req, res) => {
  res.json(await userService.list(req.query, req.user));
};

exports.get = async (req, res) => {
  res.json(await userService.get(req.params.id, req.user));
};

// Responds with the user and its temporary password, which is shown only this once.
exports.create = async (req, res) => {
  res.status(201).json(await userService.create(req.body, req.user, req.ip));
};

exports.invite = async (req, res) => {
  const { name, email, role, roleTitle } = req.body;
  const result = await userService.invite({ name, email, role, roleTitle }, req.user, req.ip);
  res.status(201).json(result);
};

exports.resendInvite = async (req, res) => {
  const { email } = req.body;
  const result = await userService.resendInvite({ email }, req.user, req.ip);
  res.json(result);
};

exports.update = async (req, res) => {
  res.json(await userService.update(req.params.id, req.body, req.user, req.ip));
};

exports.remove = async (req, res) => {
  await userService.deactivate(req.params.id, req.user, req.ip);
  res.status(204).end();
};
