const { PrismaClient } = require('@prisma/client');
const { connect, exec } = require('../utils/ssh');
const { decrypt } = require('../utils/crypto');
const p = new PrismaClient();

async function main() {
  const server = await p.server.findUnique({ where: { id: 'cmw9slsm5000aqy41c4neax1m' } });
  const { conn } = await connect({
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    secret: decrypt(server.secretEnc),
    passphrase: server.passphraseEnc ? decrypt(server.passphraseEnc) : undefined,
  });

  console.log('=== BEFORE CLEANUP ===');
  const beforeDisk = await exec(conn, 'df -h . && df -i .');
  console.log(beforeDisk.stdout);

  console.log('=== RUNNING THOROUGH CLEANUP ===');
  const commands = [
    // 1. Truncate all PM2 logs and remove backups
    'for p in /opt/alt/alt-nodejs22/root/usr/bin "$HOME/.local/bin" /usr/local/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done; pm2 flush 2>/dev/null || true',
    'rm -rf ~/.pm2/logs/* ~/.pm2/dump.pm2.bak 2>/dev/null || true',
    
    // 2. Clear npm cache, nvm cache, pip cache, and /tmp artifacts
    'npm cache clean --force 2>/dev/null || true',
    'rm -rf ~/.npm ~/.cache ~/.nvm/.cache /tmp/npm* /tmp/v8* /tmp/test* /tmp/server* /tmp/sock* /tmp/*.log /tmp/*.js 2>/dev/null || true',
    
    // 3. Clear Hostinger & cPanel trash folders
    'rm -rf ~/.trash/* ~/.local/share/Trash/* 2>/dev/null || true',
    'find ~/domains -type d -name ".trash" -exec rm -rf {} + 2>/dev/null || true',
    'find ~/domains -type d -name "node_modules/.cache" -exec rm -rf {} + 2>/dev/null || true',
    
    // 4. Prune old releases in apis and api if any exist
    'if [ -d "/home/u913128959/domains/portalops.online/public_html/apis/releases" ]; then cd /home/u913128959/domains/portalops.online/public_html/apis/releases && ls -dt * 2>/dev/null | tail -n +3 | xargs rm -rf 2>/dev/null || true; fi',
    'if [ -d "/home/u913128959/domains/portalops.online/public_html/api/releases" ]; then cd /home/u913128959/domains/portalops.online/public_html/api/releases && ls -dt * 2>/dev/null | tail -n +3 | xargs rm -rf 2>/dev/null || true; fi',

    // 5. Git garbage collection across domains
    'for g in ~/domains/*/public_html/*/.git ~/domains/*/public_html/.git; do if [ -d "$g" ]; then (cd "$g/.." && git gc --prune=now 2>/dev/null || true); fi; done',
  ];

  for (const cmd of commands) {
    try {
      await exec(conn, cmd);
    } catch (e) {
      console.log('Notice on cmd:', e.message);
    }
  }

  console.log('=== AFTER CLEANUP ===');
  const afterDisk = await exec(conn, 'df -h . && df -i .');
  console.log(afterDisk.stdout);

  console.log('=== PROCESS STATUS ===');
  const psCount = await exec(conn, 'ps aux | wc -l');
  console.log('Active processes:', psCount.stdout.trim());

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});
