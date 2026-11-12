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

  const appDir = '/home/u913128959/domains/portalops.online/public_html/apis';

  console.log('1. Killing all node processes...');
  await exec(conn, 'killall -9 node 2>/dev/null; pkill -9 -u u913128959 node 2>/dev/null; sleep 2');

  console.log('2. Pulling latest commit (f17dbf2)...');
  await exec(conn, `cd ${appDir} && git fetch origin main && git reset --hard origin/main`);

  console.log('3. Starting PM2 with ONLY portal-api...');
  const pm2Cmd = `for p in /opt/alt/alt-nodejs22/root/usr/bin "$HOME/.local/bin" /usr/local/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done; cd ${appDir} && pm2 delete all 2>/dev/null || true; pm2 start ecosystem.config.js; pm2 save`;
  const pm2Res = await exec(conn, pm2Cmd);
  console.log(pm2Res.stdout || pm2Res.stderr);

  await new Promise(r => setTimeout(r, 3000));

  console.log('4. Process count:');
  const count = await exec(conn, 'ps aux | wc -l');
  console.log('Active processes:', count.stdout.trim());

  console.log('5. Full process list:');
  const ps = await exec(conn, 'ps aux');
  console.log('ps:\n', ps.stdout);

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

