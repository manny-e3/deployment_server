// Who may do what. The authorize middleware uses this map, and the frontend should copy it
// to hide buttons, but only the API's check actually protects anything.
const ALL = ['ADMIN', 'DEPLOYER', 'VIEWER'];
const DEPLOYERS = ['ADMIN', 'DEPLOYER'];
const ADMINS = ['ADMIN'];

const PERMISSIONS = {
  'projects:view': ALL,
  'servers:view': ALL,
  'deployments:view': ALL,

  'deploy:create': DEPLOYERS,
  'deploy:cancel': DEPLOYERS,
  'deploy:rollback': DEPLOYERS,

  'projects:manage': ADMINS,
  'servers:manage': ADMINS,
  'users:manage': ADMINS,
  'audit:view': ADMINS,
};

/** True when the role may perform the action. Unknown actions are always refused. */
function can(role, action) {
  return PERMISSIONS[action]?.includes(role) ?? false;
}

module.exports = { PERMISSIONS, can };
