const healthService = require('../services/health.service');

exports.show = async (req, res) => {
  const health = await healthService.getHealth();
  res.status(health.status === 'ok' ? 200 : 503).json(health);
};
