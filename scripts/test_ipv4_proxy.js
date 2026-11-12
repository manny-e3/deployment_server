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

  // 1. Kill any existing process on 9825
  await exec(conn, 'fuser -k 9825/tcp 2>/dev/null || true');

  // 2. Start a simple node server EXPLICITLY on 0.0.0.0:9825
  const serverScript = `
const http = require('http');
const s = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', server: 'Node on 0.0.0.0:9825', url: req.url }));
});
s.listen(9825, '0.0.0.0', () => {
  console.log('LISTENING_ON_IPV4');
});
`;
  await exec(conn, `nohup /opt/alt/alt-nodejs22/root/usr/bin/node -e "${serverScript.replace(/\n/g, ' ')}" >/tmp/server9825.log 2>&1 &`);
  await new Promise(r => setTimeout(r, 1000));

  // 3. Test local curl from the server itself
  const curlRes = await exec(conn, 'curl -is http://127.0.0.1:9825/api/v1/health');
  console.log('Local curl:\n', curlRes.stdout);

  // 4. Write .htaccess reverse proxy to http://127.0.0.1:9825
  const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^(.*)$ http://127.0.0.1:9825/$1 [P,L]
</IfModule>
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/.htaccess\n${htaccess}\nEOF`);
  console.log('.htaccess written to reverse proxy 9825!');

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

