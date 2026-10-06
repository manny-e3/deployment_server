const deploymentService = require('../services/deployment.service');

// POST /projects/:id/deploy — answers at once; progress arrives over Socket.IO.
exports.start = async (req, res) => {
  const result = await deploymentService.start({
    projectId: req.params.id,
    targetIds: req.body.targetIds,
    branch: req.body.branch,
    trigger: 'MANUAL',
    user: req.user,
    ip: req.ip,
  });
  res.status(202).json(result);
};

exports.list = async (req, res) => {
  res.json(await deploymentService.list(req.query));
};

exports.get = async (req, res) => {
  res.json(await deploymentService.get(req.params.id));
};

exports.logs = async (req, res) => {
  res.json(await deploymentService.logs(req.params.id, req.query));
};

exports.cancel = async (req, res) => {
  res.status(202).json(await deploymentService.cancel(req.params.id, req.user, req.ip));
};

exports.rollback = async (req, res) => {
  res.status(202).json(await deploymentService.rollback(req.params.id, req.user, req.ip));
};
