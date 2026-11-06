const healthService = require('../services/health.service');

exports.show = async (req, res) => {
  const health = await healthService.getHealth();
  const isAvailable = health.checks.database.status === 'up';
  res.status(isAvailable ? 200 : 503).json(health);
};
