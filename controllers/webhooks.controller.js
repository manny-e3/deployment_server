const webhookService = require('../services/webhook.service');

const handler = (provider) => async (req, res) => {
  const { statusCode, body } = await webhookService.handle({
    provider,
    projectId: req.params.projectId,
    rawBody: req.body,
    headers: req.headers,
    ip: req.ip,
  });
  res.status(statusCode).json(body);
};

exports.github = handler('github');
exports.gitlab = handler('gitlab');
