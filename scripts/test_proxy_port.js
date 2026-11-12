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
  const port = 9876;

  console.log('1. Stopping PM2 and killing stale processes...');
  await exec(conn, 'for p in /opt/alt/alt-nodejs22/root/usr/bin "$HOME/.local/bin" /usr/local/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done; pm2 delete all 2>/dev/null || true; killall -9 node 2>/dev/null || true; sleep 1');

  console.log('2. Starting test HTTP server on port ' + port + '...');
  const serverScript = `
const http = require('http');
const s = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString(), url: req.url }));
});
s.listen(${port}, '127.0.0.1', () => {
  console.log('SERVER_UP_ON_' + ${port});
});
`;
  await exec(conn, `nohup /opt/alt/alt-nodejs22/root/usr/bin/node -e "${serverScript.replace(/\n/g, ' ')}" >/tmp/test_9876.log 2>&1 &`);
  await new Promise(r => setTimeout(r, 1000));

  console.log('3. Writing .htaccess reverse proxy to port ' + port + '...');
  const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^(.*)$ http://127.0.0.1:${port}/$1 [P,L]
</IfModule>
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/.htaccess\n${htaccess}\nEOF`);

  console.log('4. Checking test server log:');
  const log = await exec(conn, 'cat /tmp/test_9876.log');
  console.log(log.stdout);

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

