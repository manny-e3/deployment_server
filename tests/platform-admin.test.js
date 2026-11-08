const { signAccessToken } = require('../utils/tokens');
const prisma = require('../models/prisma');

async function runTests() {
  console.log('=== RUNNING PLATFORM SUPER ADMIN AUDIT & TEST SUITE ===\n');

  // Find a super-admin user
  const superAdmin = await prisma.user.findFirst({
    where: { isSuperAdmin: true },
  });
  if (!superAdmin) throw new Error('No super admin found in database');
  console.log(`[Test] Using Super Admin: ${superAdmin.email} (${superAdmin.id})`);

  // Find a normal user
  const normalUser = await prisma.user.findFirst({
    where: { isSuperAdmin: false },
  });
  if (!normalUser) throw new Error('No normal user found in database');
  console.log(`[Test] Using Normal User: ${normalUser.email} (${normalUser.id})\n`);

  const superAdminToken = signAccessToken({ id: superAdmin.id, role: superAdmin.role, tokenVersion: superAdmin.tokenVersion });
  const normalUserToken = signAccessToken({ id: normalUser.id, role: normalUser.role, tokenVersion: normalUser.tokenVersion });

  const BASE_URL = 'http://localhost:9000/api/v1/platform';

  // 1. Non-super admin rejection check
  console.log('1. Checking Non-Super Admin Access Control...');
  const rejectRes = await fetch(`${BASE_URL}/overview`, {
    headers: { 'Authorization': `Bearer ${normalUserToken}` }
  });
  if (rejectRes.status === 403) {
    console.log('   ✓ PASS: Normal user correctly blocked with 403 Forbidden');
  } else {
    throw new Error(`   ✗ FAIL: Expected 403 but got ${rejectRes.status}`);
  }

  // 2. Super admin overview
  console.log('\n2. Testing GET /api/v1/platform/overview...');
  const ovRes = await fetch(`${BASE_URL}/overview`, {
    headers: { 'Authorization': `Bearer ${superAdminToken}` }
  });
  if (ovRes.status === 200) {
    const data = await ovRes.json();
    console.log(`   ✓ PASS: Overview loaded (${data.metrics.totalOrganizations} orgs, ${data.metrics.totalUsers} users, ${data.metrics.totalDeployments} deploys)`);
  } else {
    throw new Error(`   ✗ FAIL: Overview returned ${ovRes.status}`);
  }

  // 3. Super admin cross-tenant organizations
  console.log('\n3. Testing GET /api/v1/platform/organizations...');
  const orgsRes = await fetch(`${BASE_URL}/organizations`, {
    headers: { 'Authorization': `Bearer ${superAdminToken}` }
  });
  const orgsData = await orgsRes.json();
  console.log(`   ✓ PASS: Listed ${orgsData.organizations.length} organizations across platform`);

  // 4. Super admin cross-tenant users
  console.log('\n4. Testing GET /api/v1/platform/users...');
  const usersRes = await fetch(`${BASE_URL}/users`, {
    headers: { 'Authorization': `Bearer ${superAdminToken}` }
  });
  const usersData = await usersRes.json();
  console.log(`   ✓ PASS: Listed ${usersData.users.length} users across platform with workspace affiliations`);

  // 5. Super admin cross-tenant deployments
  console.log('\n5. Testing GET /api/v1/platform/deployments...');
  const deploysRes = await fetch(`${BASE_URL}/deployments`, {
    headers: { 'Authorization': `Bearer ${superAdminToken}` }
  });
  const deploysData = await deploysRes.json();
  console.log(`   ✓ PASS: Fetched ${deploysData.deployments.length} cross-tenant deployments`);

  // 6. Super admin system health & telemetry
  console.log('\n6. Testing GET /api/v1/platform/system-health...');
  const healthRes = await fetch(`${BASE_URL}/system-health`, {
    headers: { 'Authorization': `Bearer ${superAdminToken}` }
  });
  const healthData = await healthRes.json();
  console.log(`   ✓ PASS: System health status is ${healthData.health.status} (DB: ${healthData.health.checks.database.status}, Redis: ${healthData.health.checks.redis.status})`);

  // 7. Super admin backups list
  console.log('\n7. Testing GET /api/v1/platform/backups...');
  const backupsRes = await fetch(`${BASE_URL}/backups`, {
    headers: { 'Authorization': `Bearer ${superAdminToken}` }
  });
  const backupsData = await backupsRes.json();
  console.log(`   ✓ PASS: Listed ${backupsData.backups.length} database snapshot archives`);

  // 8. Super admin organization creation & suspension lifecycle
  console.log('\n8. Testing Workspace Creation & Suspension Lifecycle...');
  const testOrgName = `Test Tenant ${Date.now()}`;
  const testOrgSlug = `test-tenant-${Date.now()}`;
  const csrfToken = 'test-csrf-token-12345';
  const writeHeaders = {
    'Authorization': `Bearer ${superAdminToken}`,
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    'Cookie': `csrf_token=${csrfToken}`,
  };

  const createOrgRes = await fetch(`${BASE_URL}/organizations`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ name: testOrgName, slug: testOrgSlug })
  });
  const createOrgJson = await createOrgRes.json();
  const createdOrg = createOrgJson.organization;
  console.log(`   ✓ PASS: Provisioned workspace "${createdOrg.name}" (${createdOrg.id})`);

  // Suspend workspace
  const suspendRes = await fetch(`${BASE_URL}/organizations/${createdOrg.id}/status`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ isActive: false })
  });
  const suspendedOrg = (await suspendRes.json()).organization;
  if (suspendedOrg.isActive === false) {
    console.log(`   ✓ PASS: Suspended workspace "${suspendedOrg.name}" successfully`);
  } else {
    throw new Error('   ✗ FAIL: Workspace was not suspended');
  }

  // Reactivate workspace
  const reactivateRes = await fetch(`${BASE_URL}/organizations/${createdOrg.id}/status`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ isActive: true })
  });
  const reactivatedOrg = (await reactivateRes.json()).organization;
  if (reactivatedOrg.isActive === true) {
    console.log(`   ✓ PASS: Reactivated workspace "${reactivatedOrg.name}" successfully`);
  } else {
    throw new Error('   ✗ FAIL: Workspace was not reactivated');
  }

  // 9. User suspension and reactivation check
  console.log('\n9. Testing User Account Suspension & Reactivation...');
  const userSuspendRes = await fetch(`${BASE_URL}/users/${normalUser.id}/status`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ isActive: false })
  });
  const suspendedUser = (await userSuspendRes.json()).user;
  if (suspendedUser.isActive === false) {
    console.log(`   ✓ PASS: Suspended user "${suspendedUser.email}" successfully`);
  } else {
    throw new Error('   ✗ FAIL: User was not suspended');
  }

  const userReactivateRes = await fetch(`${BASE_URL}/users/${normalUser.id}/status`, {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify({ isActive: true })
  });
  const reactivatedUser = (await userReactivateRes.json()).user;
  if (reactivatedUser.isActive === true) {
    console.log(`   ✓ PASS: Reactivated user "${reactivatedUser.email}" successfully`);
  } else {
    throw new Error('   ✗ FAIL: User was not reactivated');
  }

  // 10. Database Backup Trigger
  console.log('\n10. Testing Trigger Database Backup...');
  const backupTriggerRes = await fetch(`${BASE_URL}/backup`, {
    method: 'POST',
    headers: writeHeaders
  });
  const backupTriggerData = await backupTriggerRes.json();
  if (backupTriggerRes.status === 200 && backupTriggerData.success) {
    console.log(`   ✓ PASS: Triggered backup "${backupTriggerData.latest.filename}" (${backupTriggerData.latest.sizeFormatted})`);
  } else {
    throw new Error(`   ✗ FAIL: Backup trigger failed with status ${backupTriggerRes.status}`);
  }

  // Cleanup test workspace
  await prisma.organization.delete({ where: { id: createdOrg.id } });
  console.log(`   ✓ Cleaned up temporary test workspace`);

  console.log('\n=== ALL PLATFORM SUPER ADMIN VERIFICATION TESTS PASSED SUCCESSFULLY! ===');
}

runTests()
  .catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
