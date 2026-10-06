const auditLogModel = require('../models/auditLog.model');

exports.list = async (req, res) => {
  res.json(await auditLogModel.list(req.query));
};
