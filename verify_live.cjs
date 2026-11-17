const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ssh = require('./utils/ssh');
const { decrypt } = require('./utils/crypto');

async function checkLiveServer() {
  const server = await prisma.server.findUnique({
    where: { id: 'cmwhqb9pu0009qy414s1a82kx' }
  });
  const secret = decrypt(server.secretEnc);
  const { conn } = await ssh.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    secret,
    expectedFingerprint: server.hostKeyFingerprint
  });

  const runCmd = (cmd) => new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => out += d);
      stream.on('close', () => resolve(out.trim()));
    });
  });

  console.log('Checking live index.html on server:');
  const headRes = await runCmd('head -n 25 /home/u913128959/domains/portalops.online/public_html/index.html');
  console.log(headRes);

  console.log('\nChecking live assets on server:');
  const lsRes = await runCmd('ls -lh /home/u913128959/domains/portalops.online/public_html/assets/');
  console.log(lsRes);

  conn.end();
  await prisma.$disconnect();
}

checkLiveServer().catch(e => {
  console.error(e);
  process.exit(1);
});

