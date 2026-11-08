const platformService = require('../services/platform.service');

async function overview(_req, res) {
  const data = await platformService.getOverview();
  res.json(data);
}

async function listOrganizations(req, res) {
  const data = await platformService.listOrganizations(req.query);
  res.json({ organizations: data });
}

async function createOrganization(req, res) {
  const data = await platformService.createOrganization(req.body, req.user, req.ip);
  res.status(201).json({ organization: data });
}

async function toggleOrganizationStatus(req, res) {
  const data = await platformService.toggleOrganizationStatus(req.params.id, req.body, req.user, req.ip);
  res.json({ organization: data });
}

async function listUsers(req, res) {
  const data = await platformService.listUsers(req.query);
  res.json({ users: data });
}

async function toggleUserStatus(req, res) {
  const data = await platformService.toggleUserStatus(req.params.id, req.body, req.user, req.ip);
  res.json({ user: data });
}

async function toggleUserSuperAdmin(req, res) {
  const data = await platformService.toggleUserSuperAdmin(req.params.id, req.body, req.user, req.ip);
  res.json({ user: data });
}

async function listDeployments(req, res) {
  const data = await platformService.listDeployments(req.query);
  res.json({ deployments: data });
}

async function getSystemHealth(_req, res) {
  const data = await platformService.getSystemHealthTelemetry();
  res.json({ health: data });
}

async function triggerBackup(req, res) {
  const result = await platformService.triggerDatabaseBackup(req.user, req.ip);
  res.json(result);
}

async function listBackups(_req, res) {
  const backups = platformService.listAvailableBackups();
  res.json({ backups });
}

async function listAuditLogs(req, res) {
  const logs = await platformService.listAuditLogs(req.query);
  res.json({ logs });
}

module.exports = {
  overview,
  listOrganizations,
  createOrganization,
  toggleOrganizationStatus,
  listUsers,
  toggleUserStatus,
  toggleUserSuperAdmin,
  listDeployments,
  getSystemHealth,
  triggerBackup,
  listBackups,
  listAuditLogs,
};

