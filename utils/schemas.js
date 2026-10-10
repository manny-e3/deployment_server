// Zod schemas for request checks (used with the validate middleware).
const { z } = require('zod');

const idParams = z.object({ id: z.cuid() });

const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

const role = z.enum(['ADMIN', 'DEPLOYER', 'VIEWER']);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('must be a valid email address').max(191));
const newPassword = z
  .string()
  .min(12, 'must be at least 12 characters')
  .max(128, 'must be at most 128 characters');
const name = z.string().trim().min(1).max(191);

// Login does not enforce the 12-character rule, so old passwords still work.
const loginBody = z.object({ email, password: z.string().min(1).max(128) });

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword,
});

const createUserBody = z.object({ name, email, role: role.default('VIEWER') });

const updateUserBody = z
  .strictObject({ name: name.optional(), role: role.optional(), isActive: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'send at least one of name, role, isActive');

// ---- Servers ----

const host = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .regex(/^[A-Za-z0-9.:-]+$/, 'must be a hostname or IP address');
const sshUser = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (u) => /^[a-zA-Z0-9_.\\/@$-]+$/.test(u),
    'must be a valid Linux or Windows user name (e.g. deploy, Administrator, DOMAIN\\user)'
  );
const port = z.coerce.number().int().min(1).max(65535);
const authType = z.enum(['KEY', 'PASSWORD']);
const secret = z.string().min(1).max(16_384);
const looksLikePrivateKey = (value) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);

const createServerBody = z
  .object({
    name,
    host,
    port: port.default(22),
    username: sshUser,
    authType,
    secret,
    passphrase: z.string().min(1).max(1024).optional(),
  })
  .refine((b) => b.authType !== 'KEY' || looksLikePrivateKey(b.secret), {
    path: ['secret'],
    message: 'must be a private key in PEM or OpenSSH format',
  });

const updateServerBody = z
  .strictObject({
    name: name.optional(),
    host: host.optional(),
    port: port.optional(),
    username: sshUser.optional(),
    authType: authType.optional(),
    secret: secret.optional(),
    passphrase: z.string().min(1).max(1024).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'send at least one field to change')
  .refine((b) => b.authType === undefined || b.secret !== undefined, {
    path: ['secret'],
    message: 'is required when changing authType',
  })
  .refine((b) => b.authType !== 'KEY' || looksLikePrivateKey(b.secret), {
    path: ['secret'],
    message: 'must be a private key in PEM or OpenSSH format',
  });

// ---- Projects, targets and env vars ----

// Values that end up in a deploy script are kept to safe characters, as well as shell-quoted.
const branch = z
  .string()
  .trim()
  .max(191)
  .regex(/^[A-Za-z0-9._/-]+$/, 'may only contain letters, digits, . _ / and -')
  .refine((b) => !b.includes('..') && !b.startsWith('-') && !b.startsWith('/') && !b.endsWith('/'), {
    message: 'is not a valid branch name',
  });

const repoUrl = z
  .string()
  .trim()
  .max(500)
  .regex(
    /^(git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+|ssh:\/\/[A-Za-z0-9@._:/-]+|https:\/\/[A-Za-z0-9._:/-]+)$/,
    'must be an SSH (git@host:org/repo.git) or HTTPS Git URL',
  );

const targetPath = z
  .string()
  .trim()
  .max(500)
  .regex(/^\/[A-Za-z0-9._/-]+$/, 'must be an absolute path using letters, digits, . _ / and -')
  .refine((p) => !p.split('/').includes('..'), { message: 'must not contain ..' })
  .refine((p) => p.replace(/\/+$/, '') !== '', { message: 'must not be the root folder' });

const commands = z.string().max(20_000);
const healthCheckUrl = z.url({ protocol: /^https?$/ }).max(500);

const createProjectBody = z.object({
  name,
  repoUrl,
  defaultBranch: branch.default('main'),
  autoDeploy: z.boolean().default(false),
});

const updateProjectBody = z
  .strictObject({
    name: name.optional(),
    repoUrl: repoUrl.optional(),
    defaultBranch: branch.optional(),
    autoDeploy: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'send at least one field to change');

const targetParams = z.object({ id: z.cuid(), targetId: z.cuid() });

const createTargetBody = z.object({
  name,
  serverId: z.cuid(),
  path: targetPath,
  branch: branch.nullable().optional(),
  preDeploy: commands.default(''),
  postDeploy: commands.default(''),
  healthCheckUrl: healthCheckUrl.nullable().optional(),
});

const updateTargetBody = z
  .strictObject({
    name: name.optional(),
    serverId: z.cuid().optional(),
    path: targetPath.optional(),
    branch: branch.nullable().optional(),
    preDeploy: commands.optional(),
    postDeploy: commands.optional(),
    healthCheckUrl: healthCheckUrl.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'send at least one field to change');

// PUT /targets/:id/env  { "vars": { "DATABASE_URL": "...", "APP_KEY": "..." } }
const envKey = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must look like an env var name (letters, digits, _)');
const putEnvBody = z.object({
  vars: z
    .record(envKey, z.string().max(16_384))
    .refine((vars) => Object.keys(vars).length <= 200, 'at most 200 variables'),
});

// ---- Deployments ----

const deployBody = z.object({
  targetIds: z.array(z.cuid()).min(1).max(100).optional(),
  branch: branch.optional(),
});

const listDeploymentsQuery = paginationQuery.extend({
  projectId: z.cuid().optional(),
  targetId: z.cuid().optional(),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED']).optional(),
  trigger: z.enum(['MANUAL', 'WEBHOOK', 'ROLLBACK']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const logsQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

// ---- Audit log ----

const auditQuery = paginationQuery.extend({
  cursor: z.string().regex(/^\d+$/, 'must be an audit entry id').optional(),
  userId: z.cuid().optional(),
  action: z.string().max(64).optional(),
  entity: z.string().max(64).optional(),
  entityId: z.string().max(191).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

module.exports = {
  auditQuery,
  deployBody,
  listDeploymentsQuery,
  logsQuery,
  idParams,
  paginationQuery,
  loginBody,
  changePasswordBody,
  createUserBody,
  updateUserBody,
  createServerBody,
  updateServerBody,
  createProjectBody,
  updateProjectBody,
  targetParams,
  createTargetBody,
  updateTargetBody,
  putEnvBody,
};
