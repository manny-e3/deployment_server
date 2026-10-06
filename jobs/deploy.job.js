// Runs one deployment on its target server. Only the worker calls this.
//
//  1. Load the deployment; stop if it is no longer QUEUED (it was cancelled)
//  2. Set RUNNING and announce it
//  3. Decrypt the credentials, connect over SSH, check the pinned host key
//  4. Send the generated script to `bash -l -s` and stream its output into the log
//  5. Read the commit lines the script prints
//  6. Watch for a cancel request (every second) and the time limit
//  7. Optionally call the health check URL
//  8. Always: save the result, close SSH, flush the log, release the target lock, announce it
const deploymentModel = require('../models/deployment.model');
const serverModel = require('../models/server.model');
const targetModel = require('../models/target.model');
const { buildScript, killTreeScript } = require('../utils/buildScript');
const { decrypt } = require('../utils/crypto');
const { env } = require('../utils/env');
const { cancelKey, publishStatus } = require('../utils/events');
const { LogStream } = require('../utils/logStream');
const { logger } = require('../utils/logger');
const { redis } = require('../utils/redis');
const slots = require('../utils/slots');
const ssh = require('../utils/ssh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Up to `attempts` GET requests, `intervalMs` apart; true on the first 2xx answer. */
async function healthCheck(url, log, { attempts = 5, intervalMs = 3000 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
      log.system(`Health check ${i}/${attempts}: HTTP ${res.status}`);
      if (res.ok) return true;
    } catch (err) {
      log.system(`Health check ${i}/${attempts}: ${err.cause?.code ?? err.name}`);
    }
    if (i < attempts) await sleep(intervalMs);
  }
  return false;
}

/**
 * options: timeoutMs (default DEPLOY_TIMEOUT_MIN), cancelPollMs (1000),
 * projectConcurrency (default PROJECT_DEPLOY_CONCURRENCY), slotPollMs (1000),
 * healthCheck: { attempts, intervalMs } — tests change these.
 */
async function runDeployment(deploymentId, options = {}) {
  const timeoutMs = options.timeoutMs ?? env.DEPLOY_TIMEOUT_MIN * 60_000;
  const cancelPollMs = options.cancelPollMs ?? 1000;

  // 1-2
  const deployment = await deploymentModel.findForRun(deploymentId);
  if (!deployment || deployment.status !== 'QUEUED') return;
  const { target } = deployment;
  const { server, project } = target;

  // Wait for one of the project's slots, so "Deploy to all" rolls out a few targets at a time.
  // The deploy stays QUEUED meanwhile, so it can still be cancelled at once.
  const limit = options.projectConcurrency ?? env.PROJECT_DEPLOY_CONCURRENCY;
  const holdMs = timeoutMs + 5 * 60_000;
  while (!(await slots.acquire(project.id, deploymentId, limit, holdMs))) {
    await sleep(options.slotPollMs ?? 1000);
    const fresh = await deploymentModel.findById(deploymentId);
    if (fresh?.status !== 'QUEUED') return;
  }
  if (!(await deploymentModel.markRunning(deploymentId))) {
    await slots.release(project.id, deploymentId);
    return;
  }
  const announce = (fields) =>
    publishStatus({ id: deploymentId, projectId: project.id, targetId: target.id, ...fields });
  await announce({ status: 'RUNNING' });

  const result = { status: 'FAILED', exitCode: null, error: null };
  const commit = { previousSha: null, commitSha: null, commitMessage: null };
  let pid = null;

  // 5: marker lines carry data for us and are hidden from the visible log.
  const log = new LogStream(deploymentId, {
    filter(stream, line) {
      if (stream !== 'STDOUT' || !line.startsWith('__')) return { stream, line };
      const [marker, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (marker === '__PID__') pid = Number(value);
      else if (marker === '__PREV__') commit.previousSha = value === 'none' ? null : value;
      else if (marker === '__COMMIT__') {
        commit.commitSha = rest[0];
        commit.commitMessage = rest.slice(1).join(' ') || null;
        return { stream: 'SYSTEM', line: `Deploying commit ${rest[0].slice(0, 12)}: ${commit.commitMessage ?? ''}` };
      } else if (marker === '__STEP__') return { stream: 'SYSTEM', line: value };
      else return { stream, line };
      return null;
    },
  });

  let conn;
  let stopReason = null;
  const timers = [];

  try {
    // 3
    log.system(`Connecting to ${server.name} (${server.host}:${server.port}) as ${server.username}`);
    const connected = await ssh.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      authType: server.authType,
      secret: decrypt(server.secretEnc),
      passphrase: server.passphraseEnc ? decrypt(server.passphraseEnc) : undefined,
      expectedFingerprint: server.hostFingerprint,
    });
    conn = connected.conn;
    if (!server.hostFingerprint) {
      await serverModel.update(server.id, { hostFingerprint: connected.fingerprint });
      log.system(`First connection: pinned host key ${connected.fingerprint}`);
    }

    // 4
    const script = buildScript({
      repoUrl: project.repoUrl,
      branch: deployment.branch,
      path: target.path,
      sha: deployment.requestedSha,
      envVars: Object.fromEntries(target.envVars.map((v) => [v.key, decrypt(v.valueEnc)])),
      preDeploy: target.preDeploy,
      postDeploy: target.postDeploy,
    });
    const channel = await ssh.spawn(conn, 'bash -l -s', script);

    // 6
    const stop = async (reason) => {
      if (stopReason) return;
      stopReason = reason;
      log.system(
        reason === 'CANCELLED'
          ? 'Cancel requested: stopping the script'
          : `Time limit of ${Math.round(timeoutMs / 1000)} s reached: stopping the script`,
      );
      if (pid) {
        await ssh.exec(conn, 'bash -s', { stdin: killTreeScript(pid), timeoutMs: 5000 }).catch(() => {});
      }
      conn.end();
    };
    timers.push(setTimeout(() => stop('TIMEOUT'), timeoutMs));
    timers.push(
      setInterval(async () => {
        if (await redis.exists(cancelKey(deploymentId)).catch(() => 0)) stop('CANCELLED');
      }, cancelPollMs),
    );

    const exitCode = await new Promise((resolve) => {
      let code = null;
      channel.on('data', (chunk) => log.write('STDOUT', chunk));
      channel.stderr.on('data', (chunk) => log.write('STDERR', chunk));
      channel.on('exit', (c) => (code = c));
      channel.on('close', () => resolve(code));
      conn.on('close', () => resolve(code));
    });
    result.exitCode = exitCode;

    if (stopReason === 'CANCELLED') {
      result.status = 'CANCELLED';
    } else if (stopReason === 'TIMEOUT') {
      result.error = 'TIMEOUT';
    } else if (exitCode !== 0) {
      result.error = `Script exited with code ${exitCode}`;
      log.system(result.error);
    } else if (target.healthCheckUrl) {
      // 7
      log.system(`Checking ${target.healthCheckUrl}`);
      const healthy = await healthCheck(target.healthCheckUrl, log, options.healthCheck);
      if (healthy) result.status = 'SUCCESS';
      else result.error = 'HEALTH_CHECK_FAILED';
    } else {
      result.status = 'SUCCESS';
    }
  } catch (err) {
    if (err instanceof ssh.SshError) {
      result.error = err.reason;
      log.system(err.message);
      if (err.reason === 'HOST_KEY_CHANGED') {
        log.system(`Expected ${err.details.expected}, got ${err.details.received}. Deploy refused.`);
      }
    } else {
      result.error = 'INTERNAL_ERROR';
      log.system('The deploy stopped because of an internal error');
      logger.error({ err, deploymentId }, 'deploy job failed');
    }
  } finally {
    // 8
    timers.forEach(clearTimeout);
    timers.forEach(clearInterval);
    conn?.end();
    if (result.status === 'SUCCESS') log.system('Deploy finished');
    await log.close();

    const finishedAt = new Date();
    await deploymentModel.update(deploymentId, { ...result, ...commit, finishedAt });
    await targetModel.releaseLock(deploymentId);
    await slots.release(project.id, deploymentId);
    await redis.del(cancelKey(deploymentId)).catch(() => {});
    await announce({ ...result, commitSha: commit.commitSha, finishedAt });
    logger.info(
      { deploymentId, status: result.status, exitCode: result.exitCode, ms: finishedAt - deployment.queuedAt },
      'deploy finished',
    );
  }
}

module.exports = { runDeployment, healthCheck };
