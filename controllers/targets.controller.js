const targetService = require('../services/target.service');

exports.getEnv = async (req, res) => {
  res.json(await targetService.getEnvKeys(req.params.id));
};

exports.getEnvFull = async (req, res) => {
  res.json(await targetService.getEnvFull(req.params.id));
};

exports.putEnv = async (req, res) => {
  res.json(await targetService.replaceEnv(req.params.id, req.body.vars, req.user, req.ip));
};

exports.importSql = async (req, res) => {
  res.json(await targetService.importSql(req.params.id, req.body, req.user, req.ip));
};

exports.runArtisan = async (req, res) => {
  res.json(await targetService.runArtisan(req.params.id, req.body.command, req.user, req.ip));
};
