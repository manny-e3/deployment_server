#!/usr/bin/env node
/**
 * Automated Database & Metadata Backup Utility
 * Pure JavaScript - performs transactional dumps with Gzip compression and SHA-256 integrity verification.
 */
const { createDatabaseBackup } = require('../services/backup.service');
const prisma = require('../models/prisma');

async function main() {
  console.log('[Backup] Starting database snapshot backup...');
  const res = await createDatabaseBackup();
  console.log(`[Backup] Success! Archive: ${res.filename}`);
  console.log(`[Backup] Size: ${res.sizeFormatted}`);
  console.log(`[Backup] SHA-256: ${res.sha256}`);
}

main()
  .catch((err) => {
    console.error('[Backup] Failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
