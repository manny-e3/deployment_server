const userService = require('../services/user.service');

exports.list = async (req, res) => {
  res.json(await userService.list(req.query));
};

exports.get = async (req, res) => {
  res.json(await userService.get(req.params.id));
};

// Responds with the user and its temporary password, which is shown only this once.
exports.create = async (req, res) => {
  res.status(201).json(await userService.create(req.body, req.user, req.ip));
};

exports.update = async (req, res) => {
  res.json(await userService.update(req.params.id, req.body, req.user, req.ip));
};

exports.remove = async (req, res) => {
  await userService.deactivate(req.params.id, req.user, req.ip);
  res.status(204).end();
};
