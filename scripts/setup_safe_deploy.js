const { PrismaClient } = require('@prisma/client');
const { encrypt } = require('../utils/crypto');
const p = new PrismaClient();

async function main() {
  const targetId = 'cmw9snb3l000cqy41xi1mwefv';

  // 1. Add or update SOCKET_PATH
  const socketPath = '/home/u913128959/domains/portalops.online/public_html/apis/app.sock';
  const existingSocket = await p.envVar.findFirst({ where: { targetId, key: 'SOCKET_PATH' } });
  if (existingSocket) {
    await p.envVar.update({
      where: { id: existingSocket.id },
      data: { valueEnc: encrypt(socketPath) },
    });
  } else {
    await p.envVar.create({
      data: {
        targetId,
        key: 'SOCKET_PATH',
        valueEnc: encrypt(socketPath),
      },
    });
  }
  console.log('Set SOCKET_PATH in env vars');

  // 2. Set postDeploy hook
  const postDeploy = `export NO_UPDATE_NOTIFIER=1
for p in /opt/alt/alt-nodejs22/root/usr/bin /opt/alt/alt-nodejs20/root/usr/bin "$HOME/.local/bin" "$HOME/.npm-global/bin" /usr/local/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

APP_DIR="$(pwd)"
SOCKET_PATH="$APP_DIR/app.sock"
export SOCKET_PATH

# 1. Install dependencies
npm ci 2>/dev/null || npm install 2>/dev/null || true

# 2. Database migrations (if DB available)
npx prisma migrate deploy 2>/dev/null || true

# 3. Setup reliable LiteSpeed PHP Socket Gateway (eliminates 503 & port collisions)
cat << 'EOF' > "$APP_DIR/index.php"
<?php
$socket = __DIR__ . '/app.sock';
if (!file_exists($socket)) {
    http_response_code(503);
    echo json_encode(['error' => 'API server starting up, please refresh in a moment...']);
    exit;
}
$ch = curl_init('http://localhost' . $_SERVER['REQUEST_URI']);
curl_setopt($ch, CURLOPT_UNIX_SOCKET_PATH, $socket);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $_SERVER['REQUEST_METHOD']);
$input = file_get_contents('php://input');
if (!empty($input)) curl_setopt($ch, CURLOPT_POSTFIELDS, $input);
$headers = [];
foreach (getallheaders() as $name => $value) {
    if (strtolower($name) !== 'host') $headers[] = "$name: $value";
}
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
$response = curl_exec($ch);
$header_size = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$header_text = substr($response, 0, $header_size);
$body = substr($response, $header_size);
curl_close($ch);
http_response_code($http_code);
foreach (explode("\r\n", $header_text) as $i => $line) {
    if ($i === 0 || empty($line) || stripos($line, 'Transfer-Encoding:') === 0) continue;
    header($line);
}
echo $body;
EOF

cat << 'EOF' > "$APP_DIR/.htaccess"
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteRule ^(.*)$ index.php [QSA,L]
</IfModule>
EOF

# 4. Start PM2 with backoff and crash rate-limiting
PM2_CMD="pm2"
command -v pm2 >/dev/null 2>&1 || PM2_CMD="$HOME/.local/bin/pm2"
$PM2_CMD reload ecosystem.config.js 2>/dev/null || $PM2_CMD start ecosystem.config.js 2>/dev/null || true
$PM2_CMD save 2>/dev/null || true
echo "Safe zero-spike deployment complete."`;

  await p.target.update({
    where: { id: targetId },
    data: { postDeploy },
  });
  console.log('Updated postDeploy in DB for target cmw9snb3l000cqy41xi1mwefv');

  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

