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

  // Test Unix domain socket
  const socketPath = '/home/u913128959/domains/portalops.online/public_html/apis/test.sock';
  const cmd = `
/opt/alt/alt-nodejs22/root/usr/bin/node -e "
const http = require('http');
const fs = require('fs');
try { fs.unlinkSync('${socketPath}'); } catch (_) {}
const s = http.createServer((req, res) => res.end('HELLO_FROM_SOCKET'));
s.listen('${socketPath}', () => {
  fs.chmodSync('${socketPath}', 0o777);
  console.log('SOCKET_LISTENING');
  const req = http.request({ socketPath: '${socketPath}', path: '/' }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { console.log('SOCKET_RESPONSE:', d); process.exit(0); });
  });
  req.end();
});
"
`;
  const res = await exec(conn, cmd);
  console.log(res.stdout);

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});
