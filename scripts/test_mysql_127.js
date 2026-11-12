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

  const nodeScript = `
const { PrismaClient } = require('/home/u913128959/domains/portalops.online/public_html/apis/node_modules/@prisma/client');
(async () => {
  const prisma = new PrismaClient({
    datasources: {
      db: { url: 'mysql://u913128959_deploy:AFTeO*9g@srv1049.hstgr.io:3306/u913128959_deploy' }
    }
  });
  try {
    const users = await prisma.user.count();
    console.log('CONNECTED_TO_SRV1049! User count:', users);
  } catch (e) {
    console.log('PRISMA_ERR:', e.message);
  } finally {
    await prisma.$disconnect();
  }
})();
`;
  await exec(conn, `cat << 'EOF' > /tmp/test_prisma.js\n${nodeScript}\nEOF`);
  const res = await exec(conn, 'cd /home/u913128959/domains/portalops.online/public_html/apis && /opt/alt/alt-nodejs22/root/usr/bin/node /tmp/test_prisma.js 2>&1');
  console.log('Prisma result:\n', res.stdout);

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});
