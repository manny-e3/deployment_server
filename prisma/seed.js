const argon2 = require('argon2');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // Emails are stored lower-cased, as the API does.
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@portal.local').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  if (password.length < 12) {
    throw new Error('Set SEED_ADMIN_PASSWORD in .env (at least 12 characters) before seeding.');
  }

  // Existing admins are left alone, so re-running the seed never resets a password.
  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      name: 'Portal Admin',
      email,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: 'ADMIN',
    },
  });
  console.log(`Admin ready: ${admin.email}`);

  // Development only: a server pointing at the sshd container, to try "Test connection".
  if (process.env.NODE_ENV !== 'production') {
    const { encrypt } = require('../utils/crypto');
    const name = 'Local test server (sshd)';
    await prisma.server.upsert({
      where: { name },
      update: {},
      create: {
        name,
        host: '127.0.0.1',
        port: 2222,
        username: 'deploy',
        authType: 'PASSWORD',
        secretEnc: encrypt('deploy-test-only'),
      },
    });
    console.log(`Server ready: ${name}`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
