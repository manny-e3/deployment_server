const fs = require('node:fs');
const path = require('node:path');
const prisma = require('../models/prisma');
const userModel = require('../models/user.model');
const audit = require('./audit.service');
const authCache = require('../utils/authCache');
const { getHealth } = require('./health.service');
const { createDatabaseBackup, listAvailableBackups } = require('./backup.service');
const { NotFound, BadRequest, Conflict } = require('../utils/errors');
const { logger } = require('../utils/logger');

/**
 * Super Admin Platform Operations Service
 * Provides platform-wide observability and control across all tenants.
 */

async function getOverview() {
  const [
    totalOrganizations,
    activeOrganizations,
    totalUsers,
    activeUsers,
    totalProjects,
    totalServers,
    totalDeployments,
    runningOrQueuedDeployments,
  ] = await Promise.all([
    prisma.organization.count(),
    prisma.organization.count({ where: { isActive: true } }),
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.project.count(),
    prisma.server.count(),
    prisma.deployment.count(),
    prisma.deployment.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
  ]);

  const past24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [deploys24h, success24h, failed24h] = await Promise.all([
    prisma.deployment.count({ where: { queuedAt: { gte: past24h } } }),
    prisma.deployment.count({ where: { queuedAt: { gte: past24h }, status: 'SUCCESS' } }),
    prisma.deployment.count({ where: { queuedAt: { gte: past24h }, status: 'FAILED' } }),
  ]);

  const recentDeployments = await prisma.deployment.findMany({
    take: 6,
    orderBy: { queuedAt: 'desc' },
    select: {
      id: true,
      number: true,
      status: true,
      trigger: true,
      branch: true,
      commitSha: true,
      commitMessage: true,
      queuedAt: true,
      startedAt: true,
      finishedAt: true,
      target: {
        select: {
          id: true,
          name: true,
          project: {
            select: {
              id: true,
              name: true,
              organization: { select: { id: true, name: true } },
            },
          },
          server: { select: { id: true, name: true, host: true } },
        },
      },
      triggeredBy: { select: { id: true, name: true, email: true } },
    },
  });

  const recentOrganizations = await prisma.organization.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: { users: true, projects: true, servers: true },
      },
    },
  });

  return {
    metrics: {
      totalOrganizations,
      activeOrganizations,
      suspendedOrganizations: totalOrganizations - activeOrganizations,
      totalUsers,
      activeUsers,
      suspendedUsers: totalUsers - activeUsers,
      totalProjects,
      totalServers,
      totalDeployments,
      runningOrQueuedDeployments,
      deploys24h,
      success24h,
      failed24h,
      successRate24h: deploys24h > 0 ? Math.round((success24h / deploys24h) * 100) : 100,
    },
    recentDeployments: recentDeployments.map((d) => ({
      id: d.id,
      number: d.number,
      status: d.status,
      trigger: d.trigger,
      branch: d.branch,
      commitSha: d.commitSha,
      commitMessage: d.commitMessage,
      queuedAt: d.queuedAt,
      durationSec: d.finishedAt && d.startedAt ? Math.round((new Date(d.finishedAt) - new Date(d.startedAt)) / 1000) : null,
      projectName: d.target?.project?.name || 'Unknown Project',
      organizationName: d.target?.project?.organization?.name || 'Independent',
      organizationId: d.target?.project?.organization?.id || null,
      targetName: d.target?.name || 'Unknown Target',
      serverHost: d.target?.server?.host || 'Unknown Server',
      triggeredByName: d.triggeredBy?.name || 'System / Webhook',
    })),
    recentOrganizations,
  };
}

async function listOrganizations({ search, status }) {
  const where = {};
  if (status === 'active') where.isActive = true;
  if (status === 'suspended') where.isActive = false;
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { slug: { contains: search } },
    ];
  }

  const organizations = await prisma.organization.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: { users: true, projects: true, servers: true },
      },
      users: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          roleTitle: true,
          isSuperAdmin: true,
          isActive: true,
          lastLoginAt: true,
        },
        take: 5,
      },
    },
  });

  return organizations;
}

async function createOrganization({ name, slug }, actor, ip) {
  if (!name || !name.trim()) throw new BadRequest('Organization name is required');
  const cleanName = name.trim();
  const cleanSlug = slug?.trim() ? slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') : null;

  const existing = await prisma.organization.findFirst({
    where: { OR: [{ name: cleanName }, ...(cleanSlug ? [{ slug: cleanSlug }] : [])] },
  });
  if (existing) throw new Conflict('An organization with this name or slug already exists');

  const org = await prisma.organization.create({
    data: {
      name: cleanName,
      slug: cleanSlug,
      isActive: true,
    },
  });

  await audit.record({
    userId: actor.id,
    action: 'platform.org_created',
    entity: 'organization',
    entityId: org.id,
    details: { name: cleanName, slug: cleanSlug },
    ip,
  });

  return org;
}

async function toggleOrganizationStatus(id, { isActive }, actor, ip) {
  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) throw new NotFound('Organization');

  const updated = await prisma.organization.update({
    where: { id },
    data: { isActive: Boolean(isActive) },
  });

  // If suspended, invalidate all user sessions belonging to this organization
  if (!isActive) {
    const orgUsers = await prisma.user.findMany({
      where: { organizationId: id },
      select: { id: true },
    });
    for (const u of orgUsers) {
      await authCache.invalidate(u.id);
    }
    await prisma.user.updateMany({
      where: { organizationId: id },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  await audit.record({
    userId: actor.id,
    action: isActive ? 'platform.org_activated' : 'platform.org_suspended',
    entity: 'organization',
    entityId: org.id,
    details: { name: org.name, isActive },
    ip,
  });

  return updated;
}

async function listUsers({ search, organizationId, role, status, isSuperAdmin }) {
  const where = {};
  if (organizationId) where.organizationId = organizationId;
  if (role) where.role = role;
  if (status === 'active') where.isActive = true;
  if (status === 'suspended') where.isActive = false;
  if (isSuperAdmin !== undefined && isSuperAdmin !== '') {
    where.isSuperAdmin = isSuperAdmin === 'true' || isSuperAdmin === true;
  }
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { email: { contains: search } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      roleTitle: true,
      isSuperAdmin: true,
      isActive: true,
      isEmailVerified: true,
      lastLoginAt: true,
      createdAt: true,
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          isActive: true,
        },
      },
    },
  });

  return users;
}

async function toggleUserStatus(id, { isActive }, actor, ip) {
  if (id === actor.id && !isActive) {
    throw new BadRequest('You cannot suspend your own account from the platform console');
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFound('User');

  const updated = await prisma.user.update({
    where: { id },
    data: {
      isActive: Boolean(isActive),
      tokenVersion: !isActive ? { increment: 1 } : undefined,
    },
    select: userModel.publicFields,
  });

  if (!isActive) {
    await authCache.invalidate(id);
  }

  await audit.record({
    userId: actor.id,
    action: isActive ? 'platform.user_activated' : 'platform.user_suspended',
    entity: 'user',
    entityId: id,
    details: { email: user.email, isActive },
    ip,
  });

  return updated;
}

async function toggleUserSuperAdmin(id, { isSuperAdmin }, actor, ip) {
  if (id === actor.id && !isSuperAdmin) {
    throw new BadRequest('You cannot remove Super Admin privileges from yourself');
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFound('User');

  const updated = await prisma.user.update({
    where: { id },
    data: { isSuperAdmin: Boolean(isSuperAdmin) },
    select: userModel.publicFields,
  });

  await authCache.invalidate(id);

  await audit.record({
    userId: actor.id,
    action: isSuperAdmin ? 'platform.superadmin_granted' : 'platform.superadmin_revoked',
    entity: 'user',
    entityId: id,
    details: { email: user.email, isSuperAdmin },
    ip,
  });

  return updated;
}

async function listDeployments({ status, organizationId, limit = 50 }) {
  const where = {};
  if (status) where.status = status;
  if (organizationId) {
    where.target = { project: { organizationId } };
  }

  const deployments = await prisma.deployment.findMany({
    where,
    take: Math.min(Number(limit) || 50, 100),
    orderBy: { queuedAt: 'desc' },
    select: {
      id: true,
      number: true,
      status: true,
      trigger: true,
      branch: true,
      commitSha: true,
      commitMessage: true,
      exitCode: true,
      error: true,
      queuedAt: true,
      startedAt: true,
      finishedAt: true,
      target: {
        select: {
          id: true,
          name: true,
          project: {
            select: {
              id: true,
              name: true,
              organization: { select: { id: true, name: true } },
            },
          },
          server: { select: { id: true, name: true, host: true } },
        },
      },
      triggeredBy: { select: { id: true, name: true, email: true } },
    },
  });

  return deployments.map((d) => ({
    id: d.id,
    number: d.number,
    status: d.status,
    trigger: d.trigger,
    branch: d.branch,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    exitCode: d.exitCode,
    error: d.error,
    queuedAt: d.queuedAt,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    durationSec: d.finishedAt && d.startedAt ? Math.round((new Date(d.finishedAt) - new Date(d.startedAt)) / 1000) : null,
    projectName: d.target?.project?.name || 'Unknown Project',
    projectId: d.target?.project?.id,
    organizationName: d.target?.project?.organization?.name || 'Default Workspace',
    organizationId: d.target?.project?.organization?.id,
    targetName: d.target?.name || 'Unknown Target',
    targetId: d.target?.id,
    serverName: d.target?.server?.name || 'Unknown Server',
    serverHost: d.target?.server?.host,
    triggeredByName: d.triggeredBy?.name || 'System / Webhook',
    triggeredByEmail: d.triggeredBy?.email,
  }));
}

async function getSystemHealthTelemetry() {
  const baseHealth = await getHealth();
  const mem = process.memoryUsage();

  return {
    ...baseHealth,
    environment: process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    memory: {
      rssMb: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
      externalMb: Math.round(mem.external / (1024 * 1024)),
    },
  };
}

async function triggerDatabaseBackup(actor, ip) {
  try {
    const backupResult = await createDatabaseBackup();

    await audit.record({
      userId: actor.id,
      action: 'platform.backup_triggered',
      entity: 'system',
      entityId: 'database',
      details: {
        filename: backupResult.filename,
        size: backupResult.sizeFormatted,
        sha256: backupResult.sha256,
      },
      ip,
    }).catch(() => {});

    return {
      success: true,
      message: 'Platform database snapshot created and verified successfully',
      latest: backupResult,
    };
  } catch (err) {
    logger.error({ err }, 'Platform backup failed');
    throw new BadRequest(`Backup failed: ${err.message}`);
  }
}

async function listAuditLogs({ limit = 50 }) {
  const logs = await prisma.auditLog.findMany({
    take: Math.min(Number(limit) || 50, 100),
    orderBy: { createdAt: 'desc' },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          organization: { select: { id: true, name: true } },
        },
      },
    },
  });

  return logs.map((l) => ({
    id: l.id.toString(),
    action: l.action,
    entity: l.entity,
    entityId: l.entityId,
    details: l.details,
    ip: l.ip,
    createdAt: l.createdAt,
    user: l.user ? {
      id: l.user.id,
      name: l.user.name,
      email: l.user.email,
      role: l.user.role,
      organizationName: l.user.organization?.name || 'Default',
    } : null,
  }));
}

module.exports = {
  getOverview,
  listOrganizations,
  createOrganization,
  toggleOrganizationStatus,
  listUsers,
  toggleUserStatus,
  toggleUserSuperAdmin,
  listDeployments,
  getSystemHealthTelemetry,
  triggerDatabaseBackup,
  listAvailableBackups,
  listAuditLogs,
};

