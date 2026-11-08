const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const prisma = require('../models/prisma');
const { logger } = require('../utils/logger');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/**
 * Serializes a value for SQL INSERT
 */
function sqlEscape(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return val.toString();
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Date) {
    return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
  }
  if (typeof val === 'object') {
    return `'${JSON.stringify(val).replace(/[\0\x08\x09\x1a\n\r"'\\\%]/g, (char) => {
      switch (char) {
        case '\0': return '\\0';
        case '\x08': return '\\b';
        case '\x09': return '\\t';
        case '\x1a': return '\\z';
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '"':
        case "'":
        case '\\':
        case '%': return '\\' + char;
        default: return char;
      }
    })}'`;
  }
  // String escaping
  const escaped = String(val).replace(/[\0\x08\x09\x1a\n\r"'\\\%]/g, (char) => {
    switch (char) {
      case '\0': return '\\0';
      case '\x08': return '\\b';
      case '\x09': return '\\t';
      case '\x1a': return '\\z';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '"':
      case "'":
      case '\\':
      case '%': return '\\' + char;
      default: return char;
    }
  });
  return `'${escaped}'`;
}

/**
 * Performs a comprehensive database backup into a compressed .sql.gz archive
 * Pure JavaScript - works inside Docker containers without mysqldump or docker CLI.
 */
async function createDatabaseBackup() {
  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
  const filename = `portal-backup-${timestamp}.sql.gz`;
  const filePath = path.join(BACKUP_DIR, filename);
  const shaPath = `${filePath}.sha256`;

  logger.info({ filename }, 'Starting database snapshot backup');

  const hash = crypto.createHash('sha256');
  const gzip = zlib.createGzip({ level: 9 });
  const writeStream = fs.createWriteStream(filePath);

  gzip.on('data', (chunk) => hash.update(chunk));
  gzip.pipe(writeStream);

  const write = (str) =>
    new Promise((resolve) => {
      if (!gzip.write(str)) {
        gzip.once('drain', resolve);
      } else {
        resolve();
      }
    });

  try {
    // Header
    await write(`-- PortalOps Database Backup
-- Generated: ${new Date().toISOString()}
-- Platform Engine: Multi-Tenant Architecture

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";

`);

    // Fetch all base tables
    const tableRows = await prisma.$queryRawUnsafe("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
    const tables = tableRows.map((r) => Object.values(r)[0]);

    for (const table of tables) {
      // 1. Structure
      const createRows = await prisma.$queryRawUnsafe(`SHOW CREATE TABLE \`${table}\``);
      const createTableSql = createRows[0]?.['Create Table'] || createRows[0]?.['create table'];

      await write(`-- Table structure for \`${table}\`\n`);
      await write(`DROP TABLE IF EXISTS \`${table}\`;\n`);
      await write(`${createTableSql};\n\n`);

      // 2. Data in batches
      const countRes = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM \`${table}\``);
      const totalRows = Number(countRes[0]?.count || 0);

      if (totalRows > 0) {
        await write(`-- Dumping data for \`${table}\` (${totalRows} rows)\n`);
        await write(`LOCK TABLES \`${table}\` WRITE;\n`);

        const BATCH_SIZE = 500;
        let offset = 0;

        while (offset < totalRows) {
          const rows = await prisma.$queryRawUnsafe(`SELECT * FROM \`${table}\` LIMIT ${BATCH_SIZE} OFFSET ${offset}`);
          if (rows.length === 0) break;

          const colNames = Object.keys(rows[0]).map((c) => `\`${c}\``).join(', ');
          const valuesList = rows.map((row) => {
            const vals = Object.values(row).map(sqlEscape).join(', ');
            return `(${vals})`;
          }).join(',\n  ');

          await write(`INSERT INTO \`${table}\` (${colNames}) VALUES\n  ${valuesList};\n`);
          offset += rows.length;
        }

        await write(`UNLOCK TABLES;\n\n`);
      }
    }

    // Footer
    await write(`SET FOREIGN_KEY_CHECKS = 1;\n-- Backup Completed Successfully\n`);

    // End gzip stream
    gzip.end();
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Write SHA-256 checksum
    const sha256 = hash.digest('hex');
    fs.writeFileSync(shaPath, `${sha256}  ${filename}\n`, 'utf8');

    // Stat the file
    const stat = fs.statSync(filePath);

    // Prune old backups (keep 14)
    pruneOldBackups(14);

    logger.info({ filename, size: stat.size, sha256 }, 'Database backup completed');

    return {
      filename,
      sizeBytes: stat.size,
      sizeFormatted: `${(stat.size / 1024).toFixed(1)} KB`,
      sha256,
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error({ err }, 'Failed to create database backup');
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    if (fs.existsSync(shaPath)) {
      try { fs.unlinkSync(shaPath); } catch {}
    }
    throw err;
  }
}

function listAvailableBackups() {
  ensureBackupDir();
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('portal-backup-') && f.endsWith('.sql.gz'))
      .map((filename) => {
        const fullPath = path.join(BACKUP_DIR, filename);
        const stat = fs.statSync(fullPath);
        const shaPath = `${fullPath}.sha256`;
        let checksum = null;
        if (fs.existsSync(shaPath)) {
          checksum = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
        }

        return {
          filename,
          sizeBytes: stat.size,
          sizeFormatted: `${(stat.size / 1024).toFixed(1)} KB`,
          createdAt: stat.mtime.toISOString(),
          checksum,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return files;
  } catch (err) {
    logger.warn({ err }, 'Error listing backup archives');
    return [];
  }
}

function pruneOldBackups(maxKeep = 14) {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('portal-backup-') && f.endsWith('.sql.gz'))
      .map((f) => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        shaPath: path.join(BACKUP_DIR, `${f}.sha256`),
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length > maxKeep) {
      const toDelete = files.slice(maxKeep);
      for (const item of toDelete) {
        if (fs.existsSync(item.path)) fs.unlinkSync(item.path);
        if (fs.existsSync(item.shaPath)) fs.unlinkSync(item.shaPath);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Warning during backup pruning');
  }
}

module.exports = {
  createDatabaseBackup,
  listAvailableBackups,
  BACKUP_DIR,
};

