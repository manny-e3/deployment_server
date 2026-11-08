#!/usr/bin/env node
/**
 * Database & Metadata Recovery Utility
 * Restores a compressed MySQL backup archive (.sql.gz) with integrity verification.
 */
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Load environment variables
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = (match[2] || '').trim().replace(/^["']|["']$/g, '');
    }
  }
}

const dbUrl = process.env.DATABASE_URL || 'mysql://portal:portal@localhost:3307/portal';
const parsed = new URL(dbUrl.replace(/^mysql:\/\//, 'http://'));

const dbUser = decodeURIComponent(parsed.username || 'portal');
const dbPass = decodeURIComponent(parsed.password || 'portal');
const dbHost = parsed.hostname || 'localhost';
const dbPort = parsed.port || '3306';
const dbName = parsed.pathname.replace(/^\//, '') || 'portal';

const backupDir = path.join(__dirname, '..', 'backups');

// Identify target backup file (either passed as arg or latest in backups/)
let targetFile = process.argv[2];
if (!targetFile) {
  if (!fs.existsSync(backupDir)) {
    console.error(`[Restore Error] No backups directory found at ${backupDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith('portal-backup-') && (f.endsWith('.sql.gz') || f.endsWith('.sql')))
    .map((f) => ({
      name: f,
      path: path.join(backupDir, f),
      time: fs.statSync(path.join(backupDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) {
    console.error(`[Restore Error] No backup archives found in ${backupDir}`);
    process.exit(1);
  }
  targetFile = files[0].path;
} else if (!path.isAbsolute(targetFile)) {
  targetFile = path.resolve(process.cwd(), targetFile);
}

if (!fs.existsSync(targetFile)) {
  console.error(`[Restore Error] Specified backup file does not exist: ${targetFile}`);
  process.exit(1);
}

console.log(`[Restore] Target database: '${dbName}' on ${dbHost}:${dbPort}`);
console.log(`[Restore] Source archive:  ${targetFile}`);

// Check if running inside docker or if docker is available
let useDockerExec = false;
try {
  const containers = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (containers.includes('deploy-portal-mysql-1')) {
    useDockerExec = true;
  }
} catch {
  useDockerExec = false;
}

let mysqlProcess;
if (useDockerExec) {
  console.log('[Restore] Restoring via container deploy-portal-mysql-1...');
  mysqlProcess = spawn('docker', [
    'exec',
    '-i',
    'deploy-portal-mysql-1',
    'mysql',
    `-u${dbUser}`,
    `-p${dbPass}`,
    dbName,
  ]);
} else {
  console.log(`[Restore] Restoring via host mysql client on ${dbHost}:${dbPort}...`);
  mysqlProcess = spawn('mysql', [
    `-h${dbHost}`,
    `-P${dbPort}`,
    `-u${dbUser}`,
    `-p${dbPass}`,
    dbName,
  ]);
}

const inputStream = fs.createReadStream(targetFile);

if (targetFile.endsWith('.gz')) {
  const gunzip = zlib.createGunzip();
  inputStream.pipe(gunzip).pipe(mysqlProcess.stdin);
} else {
  inputStream.pipe(mysqlProcess.stdin);
}

let stderrOutput = '';
mysqlProcess.stderr.on('data', (chunk) => {
  const msg = chunk.toString();
  if (!msg.includes('Using a password on the command line interface can be insecure')) {
    stderrOutput += msg;
  }
});

mysqlProcess.on('close', (code) => {
  if (code !== 0) {
    console.error(`[Restore Error] mysql restore process failed with code ${code}: ${stderrOutput}`);
    process.exit(1);
  }

  console.log('[Restore Success] Database restored successfully from backup!');
  verifyRestoredTables();
});

function verifyRestoredTables() {
  try {
    const cmd = useDockerExec
      ? `docker exec deploy-portal-mysql-1 mysql -u ${dbUser} -p${dbPass} -D ${dbName} -e "SELECT 'Users' as tbl, count(*) as count FROM \`User\` UNION SELECT 'Projects', count(*) FROM \`Project\` UNION SELECT 'Servers', count(*) FROM \`Server\` UNION SELECT 'Targets', count(*) FROM \`Target\` UNION SELECT 'Deployments', count(*) FROM \`Deployment\`;"`
      : `mysql -h ${dbHost} -P ${dbPort} -u ${dbUser} -p${dbPass} -D ${dbName} -e "SELECT 'Users' as tbl, count(*) as count FROM \`User\` UNION SELECT 'Projects', count(*) FROM \`Project\` UNION SELECT 'Servers', count(*) FROM \`Server\` UNION SELECT 'Targets', count(*) FROM \`Target\` UNION SELECT 'Deployments', count(*) FROM \`Deployment\`;"`;

    console.log('[Restore Verification] Verifying restored metadata counts:');
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    console.log(output.trim());
  } catch (err) {
    console.warn('[Restore Verification] Note: Table verification check warning:', err.message);
  }
}

