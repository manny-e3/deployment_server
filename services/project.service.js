const crypto = require('node:crypto');
const projectModel = require('../models/project.model');
const deploymentModel = require('../models/deployment.model');
const audit = require('./audit.service');
const { encrypt } = require('../utils/crypto');
const { diffFields } = require('../utils/diff');
const { Conflict, NotFound } = require('../utils/errors');

const newWebhookSecret = () => crypto.randomBytes(32).toString('hex');

/** Adds lastDeploy (or null) to every target of every project given. */
async function withLastDeploys(projects) {
  const targetIds = projects.flatMap((p) => p.targets.map((t) => t.id));
  const last = await deploymentModel.lastPerTarget(targetIds);
  return projects.map((p) => ({
    ...p,
    targets: p.targets.map((t) => ({ ...t, lastDeploy: last.get(t.id) ?? null })),
  }));
}

/** One page of projects, each with its targets and their last deploy. */
async function list(query) {
  const page = await projectModel.list(query);
  return { items: await withLastDeploys(page.items), nextCursor: page.nextCursor };
}

async function get(id) {
  const project = await projectModel.findByIdWithTargets(id);
  if (!project) throw new NotFound('Project');
  const [withDeploys] = await withLastDeploys([project]);
  return withDeploys;
}

async function getPlain(id) {
  const project = await projectModel.findById(id);
  if (!project) throw new NotFound('Project');
  return project;
}

/** Creates a project. The webhook secret is in this response only; it is stored encrypted. */
async function create(body, actor, ip) {
  const webhookSecret = newWebhookSecret();
  const project = await projectModel.create({ ...body, webhookSecretEnc: encrypt(webhookSecret) });
  await audit.record({
    userId: actor.id,
    action: 'project.created',
    entity: 'project',
    entityId: project.id,
    details: { name: project.name, repoUrl: project.repoUrl, defaultBranch: project.defaultBranch },
    ip,
  });
  return { ...project, webhookSecret };
}

async function update(id, body, actor, ip) {
  const before = await getPlain(id);
  const diff = diffFields(before, body);
  if (Object.keys(diff).length === 0) return before;

  const project = await projectModel.update(id, body);
  await audit.record({
    userId: actor.id,
    action: 'project.updated',
    entity: 'project',
    entityId: id,
    details: diff,
    ip,
  });
  return project;
}

/** Deletes the project with its targets, env vars and deploy history. Refused mid-deploy. */
async function remove(id, actor, ip) {
  const project = await getPlain(id);
  if ((await projectModel.countBusyTargets(id)) > 0) {
    throw new Conflict('DEPLOY_RUNNING', `${project.name} has a deploy queued or running`);
  }
  await projectModel.remove(id);
  await audit.record({
    userId: actor.id,
    action: 'project.deleted',
    entity: 'project',
    entityId: id,
    details: { name: project.name },
    ip,
  });
}

/** Replaces the webhook secret and returns the new one, once. The old one stops working. */
async function regenerateWebhookSecret(id, actor, ip) {
  await getPlain(id);
  const webhookSecret = newWebhookSecret();
  await projectModel.update(id, { webhookSecretEnc: encrypt(webhookSecret) });
  await audit.record({
    userId: actor.id,
    action: 'project.webhook_secret_regenerated',
    entity: 'project',
    entityId: id,
    ip,
  });
  return { webhookSecret };
}

module.exports = { list, get, getPlain, create, update, remove, regenerateWebhookSecret };
