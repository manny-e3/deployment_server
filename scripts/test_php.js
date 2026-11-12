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
  await exec(conn, `rm -f ${appDir}/.htaccess`);
  const php = `<?php
header('Content-Type: application/json');
echo json_encode(['php_status' => 'online', 'time' => date('c')]);
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/index.php\n${php}\nEOF`);

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

