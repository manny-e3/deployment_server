const { PrismaClient } = require('@prisma/client');
const { connect, exec } = require('../utils/ssh');
const { decrypt } = require('../utils/crypto');
const prisma = new PrismaClient();

async function main() {
  const target = await prisma.target.findFirst({
    where: { id: 'cmw9s1lah0006gz1gm4ax2y8l' },
    include: { server: true },
  });

  const { server } = target;
  const { conn } = await connect({
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    secret: decrypt(server.secretEnc),
    passphrase: server.passphraseEnc ? decrypt(server.passphraseEnc) : undefined,
  });

  const envPrefix = `
for p in /opt/alt/alt-nodejs22/root/usr/bin /opt/alt/alt-nodejs20/root/usr/bin /opt/cpanel/ea-nodejs22/bin /opt/cpanel/ea-nodejs20/bin "$HOME/.local/bin" "$HOME/.npm-global/bin" /usr/local/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done
`;

  console.log('1. Process count for user:');
  const count = await exec(conn, 'ps aux | wc -l');
  console.log('Process count:\n', count.stdout.trim());

  console.log('2. PM2 status:');
  const pm2Status = await exec(conn, `${envPrefix} pm2 list`);
  console.log('pm2:\n', pm2Status.stdout || pm2Status.stderr);

  console.log('3. Directory listing:');
  const ls = await exec(conn, 'ls -la /home/u913128959/domains/portalops.online/public_html/api');
  console.log('ls:\n', ls.stdout);

  console.log('4. Releases listing:');
  const releases = await exec(conn, 'ls -la /home/u913128959/domains/portalops.online/public_html/api/releases');
  console.log('releases:\n', releases.stdout);

  conn.end();
}

main().finally(() => prisma.$disconnect());
