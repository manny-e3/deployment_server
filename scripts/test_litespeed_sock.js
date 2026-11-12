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
  const socketPath = `${appDir}/app.sock`;

  // Start background socket server
  const serverScript = `
const http = require('http');
const fs = require('fs');
try { fs.unlinkSync('${socketPath}'); } catch (_) {}
const s = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', message: 'Hello from LiteSpeed Unix Socket!' }));
});
s.listen('${socketPath}', () => {
  fs.chmodSync('${socketPath}', 0o777);
  console.log('READY');
});
`;

  await exec(conn, `nohup /opt/alt/alt-nodejs22/root/usr/bin/node -e "${serverScript.replace(/\n/g, ' ')}" >/tmp/sock.log 2>&1 &`);
  await new Promise(r => setTimeout(r, 1000));

  // Configure .htaccess for LiteSpeed Unix Socket
  const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^(.*)$ "proxy:unix:${socketPath}|http://127.0.0.1/$1" [P,L]
</IfModule>
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/.htaccess\n${htaccess}\nEOF`);

  console.log('.htaccess written for unix socket!');
  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});
