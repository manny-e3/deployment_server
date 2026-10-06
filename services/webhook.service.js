// GitHub and GitLab push webhooks. A push to a branch that a target deploys starts the same
// deploy as the button, with trigger WEBHOOK and the pushed commit. Everything else is recorded
// in WebhookDelivery with the reason, and answered quickly (GitHub waits at most 10 s).
const crypto = require('node:crypto');
const { Prisma } = require('@prisma/client');
const projectModel = require('../models/project.model');
const webhookDeliveryModel = require('../models/webhookDelivery.model');
const deploymentService = require('./deployment.service');
const { decrypt } = require('../utils/crypto');
const { AppError, BadRequest, NotFound, Unauthorized } = require('../utils/errors');

const SHA = /^[0-9a-f]{40}$/;
const DELETED = /^0{40}$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

// What each provider sends, and how its request is proven genuine.
const PROVIDERS = {
  github: {
    event: (h) => h['x-github-event'],
    deliveryId: (h) => h['x-github-delivery'],
    isPush: (event) => event === 'push',
    isPing: (event) => event === 'ping',
    // sha256=<HMAC-SHA256 of the exact raw body, keyed with the secret>
    verify: (h, rawBody, secret) =>
      Boolean(h['x-hub-signature-256']) &&
      safeEqual(
        h['x-hub-signature-256'],
        `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`,
      ),
  },
  gitlab: {
    event: (h) => h['x-gitlab-event'],
    deliveryId: (h) => h['x-gitlab-event-uuid'],
    isPush: (event) => event === 'Push Hook',
    isPing: () => false,
    // GitLab sends the secret itself as a token.
    verify: (h, _rawBody, secret) => Boolean(h['x-gitlab-token']) && safeEqual(h['x-gitlab-token'], secret),
  },
};

/** Handles one delivery. Returns { statusCode, body }, or throws for refused requests. */
async function handle({ provider, projectId, rawBody, headers, ip }) {
  const spec = PROVIDERS[provider];
  const project = /^c[a-z0-9]{8,}$/i.test(projectId) ? await projectModel.findForWebhook(projectId) : null;
  if (!project) throw new NotFound('Project');

  const event = String(spec.event(headers) ?? 'unknown').slice(0, 64);
  const record = (data) => webhookDeliveryModel.create({ projectId, provider, event, ...data });

  if (!Buffer.isBuffer(rawBody)) {
    await record({ statusCode: 415, result: 'not sent as application/json' });
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Set the webhook content type to application/json');
  }
  if (!spec.verify(headers, rawBody, decrypt(project.webhookSecretEnc))) {
    // No delivery id is stored for a refused request, so it can't block a genuine one later.
    await record({ statusCode: 401, result: 'invalid signature' });
    throw new Unauthorized('The webhook signature or token is wrong', 'INVALID_SIGNATURE');
  }

  // Claim the delivery id first: a resent delivery hits the unique index and stops here.
  const rawDeliveryId = spec.deliveryId(headers);
  const deliveryId = rawDeliveryId ? `${provider}:${String(rawDeliveryId).slice(0, 150)}` : null;
  let delivery;
  try {
    delivery = await record({ deliveryId, statusCode: 202, result: 'received' });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { statusCode: 200, body: { result: 'duplicate delivery, already handled' } };
    }
    throw err;
  }

  const finish = async (statusCode, result, extra = {}) => {
    await webhookDeliveryModel.update(delivery.id, {
      statusCode,
      result: result.slice(0, 255),
      branch: extra.branch ?? null,
    });
    return { statusCode, body: { result, ...extra } };
  };

  if (spec.isPing(event)) return finish(200, 'pong');
  if (!spec.isPush(event)) return finish(200, `ignored: ${event} event`);

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    await finish(400, 'body is not valid JSON');
    throw new BadRequest('INVALID_JSON', 'The request body is not valid JSON');
  }

  const ref = String(payload.ref ?? '');
  if (!ref.startsWith('refs/heads/')) return finish(200, 'ignored: not a branch push');
  const branch = ref.slice('refs/heads/'.length);
  if (!SAFE_BRANCH.test(branch) || branch.includes('..')) return finish(200, 'ignored: unusual branch name', { branch });

  const after = String(payload.after ?? '');
  if (DELETED.test(after)) return finish(200, 'ignored: branch deleted', { branch });
  if (!SHA.test(after)) return finish(200, 'ignored: no commit in the payload', { branch });
  if (!project.autoDeploy) return finish(200, 'ignored: auto-deploy is off for this project', { branch });

  const targetIds = project.targets
    .filter((t) => (t.branch ?? project.defaultBranch) === branch)
    .map((t) => t.id);
  if (targetIds.length === 0) return finish(200, `ignored: no target deploys ${branch}`, { branch });

  const { started, skipped } = await deploymentService.start({
    projectId,
    targetIds,
    branch,
    trigger: 'WEBHOOK',
    requestedSha: after,
    user: null,
    ip,
  });
  return finish(202, `deploying ${started.length} target(s)`, { branch, started, skipped });
}

module.exports = { handle };
