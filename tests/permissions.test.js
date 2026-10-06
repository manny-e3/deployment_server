require('./setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { can } = require('../utils/permissions');

describe('can(role, action)', () => {
  it('matches the permissions matrix', () => {
    const matrix = {
      'projects:view': { ADMIN: true, DEPLOYER: true, VIEWER: true },
      'deploy:create': { ADMIN: true, DEPLOYER: true, VIEWER: false },
      'deploy:rollback': { ADMIN: true, DEPLOYER: true, VIEWER: false },
      'projects:manage': { ADMIN: true, DEPLOYER: false, VIEWER: false },
      'servers:manage': { ADMIN: true, DEPLOYER: false, VIEWER: false },
      'users:manage': { ADMIN: true, DEPLOYER: false, VIEWER: false },
      'audit:view': { ADMIN: true, DEPLOYER: false, VIEWER: false },
    };
    for (const [action, roles] of Object.entries(matrix)) {
      for (const [role, allowed] of Object.entries(roles)) {
        assert.equal(can(role, action), allowed, `${role} ${action}`);
      }
    }
  });

  it('refuses unknown actions and missing roles', () => {
    assert.equal(can('ADMIN', 'nuke:everything'), false);
    assert.equal(can(undefined, 'projects:view'), false);
  });
});
