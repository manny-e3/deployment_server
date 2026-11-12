const { PrismaClient } = require('@prisma/client');
const { encrypt } = require('../utils/crypto');
const p = new PrismaClient();

async function main() {
  const targetId = 'cmw9snb3l000cqy41xi1mwefv';

  // 1. Update PORT to 9825
  const portVar = await p.envVar.findFirst({ where: { targetId, key: 'PORT' } });
  if (portVar) {
    await p.envVar.update({
      where: { id: portVar.id },
      data: { valueEnc: encrypt('9825') },
    });
    console.log('Updated PORT to 9825');
  }

  // 2. Clear SHADOW_DATABASE_URL so Prisma does not hang
  const shadowVar = await p.envVar.findFirst({ where: { targetId, key: 'SHADOW_DATABASE_URL' } });
  if (shadowVar) {
    await p.envVar.delete({ where: { id: shadowVar.id } });
    console.log('Removed SHADOW_DATABASE_URL');
  }

  // 3. Update postDeploy script
  const postDeploy = `export NO_UPDATE_NOTIFIER=1
for p in /opt/alt/alt-nodejs22/root/usr/bin /opt/alt/alt-nodejs20/root/usr/bin "$HOME/.local/bin" "$HOME/.npm-global/bin" /usr/local/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

# Install dependencies
npm ci 2>/dev/null || npm install

# Apply database migrations
npx prisma migrate deploy 2>/dev/null || true

# Generate LiteSpeed reverse proxy .htaccess routing to port 9825
cat << 'HTACCESS' > .htaccess
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^(.*)$ http://127.0.0.1:9825/$1 [P,L]
</IfModule>
HTACCESS

# Start/Reload with PM2 using ecosystem rate-limiting
PM2_CMD="pm2"
command -v pm2 >/dev/null 2>&1 || PM2_CMD="$HOME/.local/bin/pm2"
$PM2_CMD reload ecosystem.config.js 2>/dev/null || $PM2_CMD start ecosystem.config.js 2>/dev/null || true
$PM2_CMD save 2>/dev/null || true
echo "Deployment hook complete."`;

  await p.target.update({
    where: { id: targetId },
    data: { postDeploy },
  });
  console.log('Updated postDeploy script for target cmw9snb3l000cqy41xi1mwefv');

  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

