// Fills a database with data at v1 scale, to check the project list stays fast.
//   npm run db:seed:scale              adds the data to the database in DATABASE_URL
// The perf test calls seedScale() against the test database.
const crypto = require('node:crypto');

const SCALE = { servers: 50, projects: 100, targetsPerProject: 2, deploysPerTarget: 50 };
const PREFIX = 'Scale test';

// Ids shaped like cuids, so they pass the API's id checks.
const newId = () => `c${crypto.randomBytes(12).toString('hex')}`;

async function createInChunks(model, rows, size = 2000) {
  for (let i = 0; i < rows.length; i += size) await model.createMany({ data: rows.slice(i, i + size) });
}

async function seedScale(prisma, { encrypt }, scale = SCALE) {
  const secretEnc = encrypt('not-a-real-secret');

  const servers = Array.from({ length: scale.servers }, (_, i) => ({
    id: newId(),
    name: `${PREFIX} server ${String(i + 1).padStart(2, '0')}`,
    host: `10.0.0.${i + 1}`,
    username: 'deploy',
    authType: 'PASSWORD',
    secretEnc,
  }));
  const projects = Array.from({ length: scale.projects }, (_, i) => ({
    id: newId(),
    name: `${PREFIX} project ${String(i + 1).padStart(3, '0')}`,
    repoUrl: `git@github.com:acme/app-${i + 1}.git`,
    webhookSecretEnc: secretEnc,
  }));
  const targets = projects.flatMap((project, p) =>
    Array.from({ length: scale.targetsPerProject }, (_, t) => ({
      id: newId(),
      projectId: project.id,
      serverId: servers[(p * scale.targetsPerProject + t) % servers.length].id,
      name: t === 0 ? 'Production' : `Staging ${t}`,
      path: `/var/www/app-${p + 1}-${t + 1}`,
      preDeploy: '',
      postDeploy: 'npm ci && pm2 reload app',
    })),
  );

  const statuses = ['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILED', 'CANCELLED'];
  const start = Date.now() - scale.deploysPerTarget * 3_600_000;
  const deployments = targets.flatMap((target, t) =>
    Array.from({ length: scale.deploysPerTarget }, (_, d) => {
      const queuedAt = new Date(start + d * 3_600_000 + t * 1000);
      return {
        id: newId(),
        targetId: target.id,
        trigger: 'MANUAL',
        status: statuses[(t + d) % statuses.length],
        branch: 'main',
        commitSha: crypto.randomBytes(20).toString('hex'),
        queuedAt,
        startedAt: queuedAt,
        finishedAt: new Date(queuedAt.getTime() + 60_000),
      };
    }),
  );

  await createInChunks(prisma.server, servers);
  await createInChunks(prisma.project, projects);
  await createInChunks(prisma.target, targets);
  await createInChunks(prisma.deployment, deployments);
  return { servers, projects, targets, deployments };
}

module.exports = { SCALE, PREFIX, seedScale };

if (require.main === module) {
  const prisma = require('../models/prisma');
  const { env } = require('../utils/env');
  if (env.NODE_ENV === 'production') {
    console.error('Refusing to add scale-test data to a production database.');
    process.exit(1);
  }
  seedScale(prisma, require('../utils/crypto'))
    .then(({ projects, targets, deployments }) =>
      console.log(
        `Added ${projects.length} projects, ${targets.length} targets, ${deployments.length} deploys ` +
          `(names start with "${PREFIX}").`,
      ),
    )
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
