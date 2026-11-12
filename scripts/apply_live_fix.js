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

  console.log('1. Updating .env on server...');
  await exec(conn, `sed -i 's/^PORT=.*/PORT="9825"/' ${appDir}/.env`);
  await exec(conn, `sed -i '/^SHADOW_DATABASE_URL=/d' ${appDir}/.env`);

  console.log('2. Creating .htaccess reverse proxy to port 9825...');
  const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^(.*)$ http://127.0.0.1:9825/$1 [P,L]
</IfModule>
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/.htaccess\n${htaccess}\nEOF`);

  console.log('3. Starting PM2 via ecosystem.config.js...');
  const pm2Cmd = 'for p in /opt/alt/alt-nodejs22/root/usr/bin "$HOME/.local/bin" /usr/local/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done; cd ' + appDir + ' && pm2 delete all 2>/dev/null || true; pm2 start ecosystem.config.js; pm2 save';
  const pm2Res = await exec(conn, pm2Cmd);
  console.log(pm2Res.stdout || pm2Res.stderr);

  console.log('4. Waiting 4 seconds for app boot...');
  await new Promise(r => setTimeout(r, 4000));

  console.log('5. Testing local health check on port 9825...');
  const health = await exec(conn, 'curl -is --connect-timeout 3 http://127.0.0.1:9825/api/v1/health || echo "HEALTH_FAIL"');
  console.log(health.stdout);

  console.log('6. PM2 list:');
  const pm2List = await exec(conn, 'for p in /opt/alt/alt-nodejs22/root/usr/bin "$HOME/.local/bin" /usr/local/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done; pm2 list');
  console.log(pm2List.stdout);

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

