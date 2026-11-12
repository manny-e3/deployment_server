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
  const socketPath = `${appDir}/app.sock`;

  // Start background socket server
  const serverScript = `
const http = require('http');
const fs = require('fs');
try { fs.unlinkSync('${socketPath}'); } catch (_) {}
const s = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', proxy: 'php-to-node-unix-socket', url: req.url }));
});
s.listen('${socketPath}', () => {
  fs.chmodSync('${socketPath}', 0o777);
  console.log('READY');
});
`;

  await exec(conn, `nohup /opt/alt/alt-nodejs22/root/usr/bin/node -e "${serverScript.replace(/\n/g, ' ')}" >/tmp/sock.log 2>&1 &`);
  await new Promise(r => setTimeout(r, 1000));

  // Write PHP forwarder
  const phpProxy = `<?php
$socket = '${socketPath}';
if (!file_exists($socket)) {
    http_response_code(503);
    echo json_encode(['error' => 'API backend socket not ready']);
    exit;
}

$ch = curl_init('http://localhost' . $_SERVER['REQUEST_URI']);
curl_setopt($ch, CURLOPT_UNIX_SOCKET_PATH, $socket);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $_SERVER['REQUEST_METHOD']);

// Forward request body
$input = file_get_contents('php://input');
if (!empty($input)) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $input);
}

// Forward headers
$headers = [];
foreach (getallheaders() as $name => $value) {
    if (strtolower($name) !== 'host') {
        $headers[] = "$name: $value";
    }
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
    if ($i === 0 || empty($line)) continue;
    if (stripos($line, 'Transfer-Encoding:') === 0) continue;
    header($line);
}
echo $body;
`;

  await exec(conn, `cat << 'EOF' > ${appDir}/index.php\n${phpProxy}\nEOF`);

  // Write standard SPA .htaccess routing to index.php
  const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteRule ^(.*)$ index.php [QSA,L]
</IfModule>
`;
  await exec(conn, `cat << 'EOF' > ${appDir}/.htaccess\n${htaccess}\nEOF`);

  console.log('PHP Socket Proxy installed successfully!');
  conn.end();
  p.$disconnect();
}

main().catch(err => {
  console.error(err);
  p.$disconnect();
  process.exit(1);
});

