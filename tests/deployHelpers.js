// Helpers for the end-to-end deploy tests: a Git repo inside the sshd container, and waiting.
const { TEST_SSH } = require('./setup');
const prisma = require('../models/prisma');
const { encrypt } = require('../utils/crypto');
const ssh = require('../utils/ssh');

const E2E_DIR = '/config/e2e';
const REPO = `${E2E_DIR}/app.git`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a bash script on the sshd container as the deploy user; returns stdout. */
async function remote(script) {
  const { conn } = await ssh.connect({
    host: TEST_SSH.host,
    port: TEST_SSH.port,
    username: TEST_SSH.username,
    authType: 'PASSWORD',
    secret: TEST_SSH.password,
  });
  try {
    const { stdout, stderr, code } = await ssh.exec(conn, 'bash -s', { stdin: script });
    if (code !== 0) throw new Error(`remote script failed (${code}): ${stderr}`);
    return stdout.trim();
  } finally {
    conn.end();
  }
}

/** A fresh bare repo with one commit ("v1"). Returns that commit's sha. */
const createRepo = () =>
  remote(`set -e
    pkill -f 'sleep 3[0-9]' || true
    rm -rf ${E2E_DIR} && mkdir -p ${E2E_DIR}
    git init -q --bare -b main ${REPO}
    git clone -q ${REPO} ${E2E_DIR}/work 2>/dev/null
    cd ${E2E_DIR}/work && git config user.email e2e@test && git config user.name e2e
    echo v1 > version.txt && git add . && git commit -qm "first version" && git push -q origin main
    git rev-parse HEAD`);

/** Pushes a new commit that sets version.txt to `version`. Returns its sha. */
const pushCommit = (version) =>
  remote(`set -e; cd ${E2E_DIR}/work
    echo ${version} > version.txt && git commit -qam "${version} version" && git push -q origin main
    git rev-parse HEAD`);

/** Server, project and a factory for targets that deploy that repo to the container. */
async function createFixtures() {
  const server = await prisma.server.create({
    data: {
      name: 'sshd',
      host: TEST_SSH.host,
      port: TEST_SSH.port,
      username: TEST_SSH.username,
      authType: 'PASSWORD',
      secretEnc: encrypt(TEST_SSH.password),
    },
  });
  const project = await prisma.project.create({
    data: { name: 'E2E app', repoUrl: REPO, webhookSecretEnc: encrypt('x') },
  });
  let n = 0;
  const makeTarget = (overrides = {}) => {
    n += 1;
    return prisma.target.create({
      data: {
        projectId: project.id,
        serverId: server.id,
        name: `Target ${n}`,
        path: `${E2E_DIR}/site-${n}`,
        preDeploy: '',
        postDeploy: '',
        ...overrides,
      },
    });
  };
  return { server, project, makeTarget };
}

/** Polls fn until it returns something truthy. */
async function waitFor(fn, { timeout = 45_000, interval = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

const waitForStatus = (id, statuses) =>
  waitFor(
    async () => {
      const d = await prisma.deployment.findUnique({ where: { id } });
      return statuses.includes(d.status) && d;
    },
    { what: `deployment to reach ${statuses.join('/')}` },
  );

const logLines = async (id) =>
  prisma.deploymentLog.findMany({ where: { deploymentId: id }, orderBy: { seq: 'asc' } });

const waitForLog = (id, text) =>
  waitFor(async () => (await logLines(id)).some((l) => l.line.includes(text)), {
    what: `log line "${text}"`,
  });

module.exports = {
  E2E_DIR,
  REPO,
  sleep,
  remote,
  createRepo,
  pushCommit,
  createFixtures,
  waitFor,
  waitForStatus,
  logLines,
  waitForLog,
};
