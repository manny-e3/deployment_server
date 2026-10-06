const ssh = require('../utils/ssh');
const { shellQuote } = require('../utils/buildScript');
const prisma = require('../models/prisma');
const targetModel = require('../models/target.model');
const serverModel = require('../models/server.model');
const envVarModel = require('../models/envVar.model');
const projectService = require('./project.service');
const audit = require('./audit.service');
const { decrypt, encrypt } = require('../utils/crypto');
const { diffFields } = require('../utils/diff');
const { BusinessRuleError, Conflict, NotFound } = require('../utils/errors');

async function getInProject(projectId, targetId) {
  const target = await targetModel.findInProject(projectId, targetId);
  if (!target) throw new NotFound('Target');
  return target;
}

async function assertServerExists(serverId) {
  if (!(await serverModel.findById(serverId))) {
    throw new BusinessRuleError('UNKNOWN_SERVER', 'No server with this serverId');
  }
}

const assertNotBusy = (target) => {
  if (target.activeDeploymentId) {
    throw new Conflict('DEPLOY_RUNNING', `${target.name} has a deploy queued or running`);
  }
};

// Two targets on one server cannot share a folder: the database refuses it, the error
// handler turns that into 409 ALREADY_EXISTS.

async function create(projectId, body, actor, ip) {
  await projectService.getPlain(projectId);
  await assertServerExists(body.serverId);

  const target = await targetModel.create({ ...body, projectId });
  await audit.record({
    userId: actor.id,
    action: 'target.created',
    entity: 'target',
    entityId: target.id,
    details: {
      projectId,
      name: target.name,
      serverId: target.serverId,
      path: target.path,
      branch: target.branch,
      preDeploy: target.preDeploy,
      postDeploy: target.postDeploy,
    },
    ip,
  });
  return target;
}

/** Commands changes are audited in full: they run on the server at every deploy. */
async function update(projectId, targetId, body, actor, ip) {
  const before = await getInProject(projectId, targetId);
  if (body.serverId || body.path) assertNotBusy(before);
  if (body.serverId && body.serverId !== before.serverId) await assertServerExists(body.serverId);

  const diff = diffFields(before, body);
  if (Object.keys(diff).length === 0) return before;

  const target = await targetModel.update(targetId, body);
  await audit.record({
    userId: actor.id,
    action: 'target.updated',
    entity: 'target',
    entityId: targetId,
    details: { projectId, ...diff },
    ip,
  });
  return target;
}

async function remove(projectId, targetId, actor, ip) {
  const target = await getInProject(projectId, targetId);
  assertNotBusy(target);
  await targetModel.remove(targetId);
  await audit.record({
    userId: actor.id,
    action: 'target.deleted',
    entity: 'target',
    entityId: targetId,
    details: { projectId, name: target.name, path: target.path },
    ip,
  });
}

async function getAnyTarget(targetId) {
  const target = await targetModel.findById(targetId);
  if (!target) throw new NotFound('Target');
  return target;
}

/** Env var names only. Values never leave the server once saved. */
async function getEnvKeys(targetId) {
  await getAnyTarget(targetId);
  const rows = await envVarModel.listKeys(targetId);
  return { keys: rows.map((r) => r.key) };
}

/**
 * Replaces the whole set of env vars (keys missing from `vars` are removed). The audit entry
 * names the keys added, removed and changed, never the values.
 */
async function replaceEnv(targetId, vars, actor, ip) {
  const target = await getAnyTarget(targetId);
  const existing = await envVarModel.listWithValues(targetId);
  const old = new Map(existing.map((r) => [r.key, decrypt(r.valueEnc)]));

  const keys = Object.keys(vars).sort();
  const added = keys.filter((k) => !old.has(k));
  const removed = [...old.keys()].filter((k) => !(k in vars)).sort();
  const changed = keys.filter((k) => old.has(k) && old.get(k) !== vars[k]);

  await prisma.$transaction((tx) =>
    envVarModel.replaceAll(
      targetId,
      keys.map((key) => ({ key, valueEnc: encrypt(vars[key]) })),
      tx,
    ),
  );
  await audit.record({
    userId: actor.id,
    action: 'target.env_replaced',
    entity: 'target',
    entityId: targetId,
    details: { projectId: target.projectId, added, removed, changed },
    ip,
  });
  return { keys };
}


/** Decrypts and returns full env vars (key => value) for admin configuration */
async function getEnvFull(targetId) {
  await getAnyTarget(targetId);
  const rows = await envVarModel.listWithValues(targetId);
  const vars = {};
  for (const r of rows) {
    try {
      vars[r.key] = decrypt(r.valueEnc);
    } catch {
      vars[r.key] = '';
    }
  }
  return { vars };
}

/** Imports a custom SQL file directly into the target server database over SSH */
async function importSql(targetId, data, actor, ip) {
  const target = await getAnyTarget(targetId);
  const server = await serverModel.findById(target.serverId);
  if (!server) throw new NotFound('Server');

  const sqlContent = data.sqlContent || '';
  if (!sqlContent.trim()) {
    throw new BusinessRuleError('EMPTY_SQL', 'SQL content or file is empty');
  }

  // Read decrypted target env vars for default credentials
  const rows = await envVarModel.listWithValues(targetId);
  const envMap = {};
  for (const r of rows) {
    try { envMap[r.key] = decrypt(r.valueEnc); } catch {}
  }

  const dbHost = data.dbHost || envMap.DB_HOST || '127.0.0.1';
  const dbPort = data.dbPort || envMap.DB_PORT || '3306';
  const dbName = data.dbName || envMap.DB_DATABASE;
  const dbUser = data.dbUser || envMap.DB_USERNAME;
  const dbPass = data.dbPass !== undefined ? data.dbPass : (envMap.DB_PASSWORD || '');

  if (!dbName) {
    throw new BusinessRuleError('MISSING_DB_NAME', 'Database name is required. Specify it or configure DB_DATABASE in .env');
  }
  if (!dbUser) {
    throw new BusinessRuleError('MISSING_DB_USER', 'Database username is required. Specify it or configure DB_USERNAME in .env');
  }

  const { conn } = await ssh.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    secret: decrypt(server.secretEnc),
    passphrase: server.passphraseEnc ? decrypt(server.passphraseEnc) : undefined,
    expectedFingerprint: server.hostFingerprint,
  });

  try {
    // 1. Create database if it doesn't already exist
    const safeDbName = dbName.replace(/[`"';]/g, '');
    const createCmd = `MYSQL_PWD=${shellQuote(dbPass)} mysql -h ${shellQuote(dbHost)} -P ${shellQuote(dbPort)} -u ${shellQuote(dbUser)} -e "CREATE DATABASE IF NOT EXISTS \`${safeDbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`;
    try {
      await ssh.exec(conn, createCmd, { timeoutMs: 30000 });
    } catch (e) {
      // Ignore if user lacks global CREATE DATABASE privilege on shared cPanel
    }

    // 2. Import SQL dump into database
    const importCmd = `MYSQL_PWD=${shellQuote(dbPass)} mysql -h ${shellQuote(dbHost)} -P ${shellQuote(dbPort)} -u ${shellQuote(dbUser)} \`${safeDbName}\``;
    const resImport = await ssh.exec(conn, importCmd, { stdin: sqlContent, timeoutMs: 180000 });

    if (resImport.code !== 0) {
      throw new BusinessRuleError('SQL_IMPORT_FAILED', 'MySQL import failed: ' + (resImport.stderr || 'Exit code ' + resImport.code));
    }

    await audit.record({
      userId: actor.id,
      action: 'target.sql_imported',
      entity: 'target',
      entityId: targetId,
      details: {
        projectId: target.projectId,
        dbName: safeDbName,
        dbUser,
        sizeBytes: sqlContent.length,
      },
      ip,
    });

    return {
      ok: true,
      message: `Database '${safeDbName}' imported successfully (${Math.round(sqlContent.length / 1024)} KB processed).`,
      stdout: resImport.stdout,
    };
  } finally {
    conn.end();
  }
}

/** Executes an artisan command inside the target directory over SSH */
async function runArtisan(targetId, command, actor, ip) {
  const target = await getAnyTarget(targetId);
  const server = await serverModel.findById(target.serverId);
  if (!server) throw new NotFound('Server');

  const cleanCmd = (command || '').trim();
  if (!cleanCmd) throw new BusinessRuleError('EMPTY_COMMAND', 'Artisan command is required');

  const { conn } = await ssh.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    secret: decrypt(server.secretEnc),
    passphrase: server.passphraseEnc ? decrypt(server.passphraseEnc) : undefined,
    expectedFingerprint: server.hostFingerprint,
  });

  try {
    const fullCmd = `cd ${shellQuote(target.path)} && php artisan ${cleanCmd}`;
    const res = await ssh.exec(conn, fullCmd, { timeoutMs: 60000 });

    await audit.record({
      userId: actor.id,
      action: 'target.artisan_executed',
      entity: 'target',
      entityId: targetId,
      details: {
        projectId: target.projectId,
        command: cleanCmd,
        exitCode: res.code,
      },
      ip,
    });

    return {
      ok: res.code === 0,
      exitCode: res.code,
      output: (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim(),
    };
  } finally {
    conn.end();
  }
}

module.exports = { create, update, remove, getEnvKeys, getEnvFull, replaceEnv, importSql, runArtisan };
