const serverService = require('../services/server.service');

exports.list = async (req, res) => {
  res.json(await serverService.list(req.query));
};

exports.get = async (req, res) => {
  res.json(await serverService.get(req.params.id));
};

exports.create = async (req, res) => {
  res.status(201).json(await serverService.create(req.body, req.user, req.ip));
};

exports.update = async (req, res) => {
  res.json(await serverService.update(req.params.id, req.body, req.user, req.ip));
};

exports.remove = async (req, res) => {
  await serverService.remove(req.params.id, req.user, req.ip);
  res.status(204).end();
};

exports.test = async (req, res) => {
  res.json(await serverService.testConnection(req.params.id, req.user, req.ip));
};

exports.resetFingerprint = async (req, res) => {
  res.json(await serverService.resetFingerprint(req.params.id, req.user, req.ip));
};
