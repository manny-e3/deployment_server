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

  console.log('1. Pulling latest code on server...');
  await exec(conn, `cd ${appDir} && git fetch origin main && git reset --hard origin/main`);

  console.log('2. Updating .env with SOCKET_PATH...');
  await exec(conn, `cd ${appDir} && sed -i '/^SOCKET_PATH=/d' .env && echo 'SOCKET_PATH="${appDir}/app.sock"' >> .env`);

  console.log('3. Writing LiteSpeed PHP Socket Proxy & .htaccess...');
  const phpProxy = `<?php
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
foreach (explode("\\r\\n", $header_text) as $i => $line) {
    if ($i === 0 || empty($line) || stripos($line, 'Transfer-Encoding:') === 0) continue;
    header($line);
}
echo $body;
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/index.php\n${phpProxy}\nEOF`);

  const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteRule ^(.*)$ index.php [QSA,L]
</IfModule>
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/.htaccess\n${htaccess}\nEOF`);

  console.log('4. Restarting PM2 with ecosystem.config.js...');
  const pm2Res = await exec(conn, `for p in /opt/alt/alt-nodejs22/root/usr/bin "$HOME/.local/bin" /usr/local/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done; cd ${appDir} && pm2 reload ecosystem.config.js 2>/dev/null || pm2 start ecosystem.config.js`);
  console.log(pm2Res.stdout || pm2Res.stderr);

  await new Promise(r => setTimeout(r, 4000));

  console.log('5. Process count:');
  const count = await exec(conn, 'ps aux | wc -l');
  console.log('Active processes:', count.stdout.trim());

  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

