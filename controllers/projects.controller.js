const projectService = require('../services/project.service');
const targetService = require('../services/target.service');

exports.list = async (req, res) => {
  res.json(await projectService.list(req.query));
};

exports.get = async (req, res) => {
  res.json(await projectService.get(req.params.id));
};

// The response includes webhookSecret, shown only this once.
exports.create = async (req, res) => {
  res.status(201).json(await projectService.create(req.body, req.user, req.ip));
};

exports.update = async (req, res) => {
  res.json(await projectService.update(req.params.id, req.body, req.user, req.ip));
};

exports.remove = async (req, res) => {
  await projectService.remove(req.params.id, req.user, req.ip);
  res.status(204).end();
};

exports.regenerateWebhookSecret = async (req, res) => {
  res.json(await projectService.regenerateWebhookSecret(req.params.id, req.user, req.ip));
};

exports.createTarget = async (req, res) => {
  res.status(201).json(await targetService.create(req.params.id, req.body, req.user, req.ip));
};

exports.updateTarget = async (req, res) => {
  const { id, targetId } = req.params;
  res.json(await targetService.update(id, targetId, req.body, req.user, req.ip));
};

exports.removeTarget = async (req, res) => {
  await targetService.remove(req.params.id, req.params.targetId, req.user, req.ip);
  res.status(204).end();
};
