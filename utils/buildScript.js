// Turns a target into the bash script the worker sends to `bash -l -s` on the server.
// Every value from the database goes through shellQuote(); nothing is ever joined into the
// SSH command line itself. Pre- and post-deploy commands are admin-written by design.

/** Wraps a value in single quotes, safely: it's'  ->  'it'\''s' */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** One line of a .env file, double-quoted so any value round-trips through dotenv. */
const envLine = (key, value) =>
  `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\\"').replace(/\n/g, '\\n')}"`;

/** Normalize Windows/MSYS2 path translation pitfalls (e.g. /xampp -> /c/xampp) */
function normalizeDeploymentPath(rawPath) {
  if (!rawPath) return rawPath;
  let p = String(rawPath).trim().replace(/\\/g, '/');
  // In Git Bash / MSYS2 on Windows, leading / resolves to C:\Program Files\Git.
  // Paths starting with standard Windows root folders without a drive letter (/xampp, /inetpub, etc.)
  // must be mapped to /c/ so git clones into the actual C:\ root drive.
  if (/^\/(xampp|inetpub|Users|Program Files|Windows)/i.test(p)) {
    p = `/c${p}`;
  }
  return p;
}

/**
 * Marker lines the worker reads and hides from the visible log:
 *   __PID__ <pid>            the script's own process id, used to stop it on cancel
 *   __STEP__ <name>          shown as a SYSTEM line
 *   __PREV__ <sha|none>      the commit before this deploy
 *   __COMMIT__ <sha> <msg>   the commit after it
 */
function buildScript({ repoUrl, branch, path, sha, envVars = {}, preDeploy = '', postDeploy = '', healthCheckUrl = '' }) {
  const normalizedPath = normalizeDeploymentPath(path);
  let isRootByUrl = 0;
  if (healthCheckUrl) {
    try {
      const u = new URL(healthCheckUrl);
      if (u.pathname === '/' || u.pathname === '') {
        isRootByUrl = 1;
      }
    } catch (_) {}
  }
  const lines = [
    'set -euo pipefail',
    'echo "__PID__ $$"',
    'export GIT_TERMINAL_PROMPT=0',
    'export GCM_INTERACTIVE=never',
    'export GIT_ASKPASS=""',
    'export MSYS_NO_PATHCONV=1',
    'export MSYS2_ARG_CONV_EXCL="*"',
    'export PATH="/c/Program Files/nodejs:/c/Program Files/Git/cmd:/c/Program Files/Git/bin:$PATH"',
    '# Auto-discover Node.js & npm across Hostinger, CloudLinux, cPanel, NVM, and Linux VPS (prefer Node 22 or 20)',
    'for p in /opt/alt/alt-nodejs22/root/usr/bin /opt/alt/alt-nodejs20/root/usr/bin /opt/cpanel/ea-nodejs22/bin /opt/cpanel/ea-nodejs20/bin; do',
    '  if [ -d "$p" ]; then',
    '    export PATH="$p:$PATH"',
    '    break',
    '  fi',
    'done',
    'for p in "$HOME/.local/bin" /usr/local/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done',
    'if [ -d "$HOME/.nvm" ]; then',
    '  export NVM_DIR="$HOME/.nvm"',
    '  if [ -s "$NVM_DIR/nvm.sh" ]; then',
    '    . "$NVM_DIR/nvm.sh" 2>/dev/null || true',
    '    nvm use 22 2>/dev/null || nvm use 20 2>/dev/null || true',
    '  fi',
    'fi',
    'export RAYON_NUM_THREADS=1',
    'export ROLLDOWN_WORKERS=1',
    'export UV_THREADPOOL_SIZE=1',
    'export NODE_OPTIONS="--max-old-space-size=512"',
    `REPO=${shellQuote(repoUrl)}; BRANCH=${shellQuote(branch)}; DIR=${shellQuote(normalizedPath)}; SHA=${shellQuote(sha ?? '')}`,
    '',
    'echo "__STEP__ Fetching $BRANCH"',
    'mkdir -p "$DIR"',
    'cd "$DIR"',
    'export GIT_DIR="$DIR/.git"',
    'export GIT_WORK_TREE="$DIR"',
    'git config --global --add safe.directory "$DIR" 2>/dev/null || true',
    // Clean up any stale index locks left by interrupted/canceled previous deployments
    'rm -f "$DIR/.git/index.lock" "$DIR/.git/shallow.lock"',
    // Verify valid git directory exists specifically in $DIR; if missing or corrupted, initialize it cleanly
    'if [ -d "$DIR/.git" ] && git --git-dir="$DIR/.git" rev-parse HEAD >/dev/null 2>&1; then',
    '  echo "__PREV__ $(git --git-dir="$DIR/.git" rev-parse HEAD 2>/dev/null || echo none)"',
    'else',
    '  echo "__PREV__ none"',
    '  rm -rf "$DIR/.git"',
    '  git init -q "$DIR"',
    'fi',
    'git remote remove origin 2>/dev/null || true',
    'git remote add origin "$REPO"',
    'git -c credential.helper= fetch --prune origin "$BRANCH"',
    'git checkout -f -q -B "$BRANCH" FETCH_HEAD',
    'if [ -n "$SHA" ]; then git reset --hard "$SHA"; else git reset --hard FETCH_HEAD; fi',
    'echo "__COMMIT__ $(git rev-parse HEAD) $(git log -1 --pretty=%s)"',
  ];

  // Written base64-encoded so the values never appear in the script or the log.
  const keys = Object.keys(envVars).sort();
  if (keys.length) {
    const content = `${keys.map((k) => envLine(k, envVars[k])).join('\n')}\n`;
    lines.push(
      '',
      'echo "__STEP__ Writing .env"',
      'umask 077',
      `printf '%s' ${shellQuote(Buffer.from(content).toString('base64'))} | base64 -d > .env`,
      'umask 022',
    );
  }

  // Pre-build SPA root vs subdirectory routing normalization (Linux & Windows)
  lines.push(
    '',
    'DIR_BASENAME=$(basename "$DIR")',
    `IS_ROOT_WEB_DIR=${isRootByUrl}`,
    'if [ "$IS_ROOT_WEB_DIR" -eq 0 ]; then',
    '  case "$DIR" in',
    '    */domains/*/public_html/*|*/domains/*/public_html) IS_ROOT_WEB_DIR=1 ;;',
    '  esac',
    'fi',
    'if [ "$IS_ROOT_WEB_DIR" -eq 0 ]; then',
    '  case "$DIR_BASENAME" in',
    '    public_html|html|www|public|htdocs|web) IS_ROOT_WEB_DIR=1 ;;',
    '  esac',
    'fi',
    '',
    'if [ "$IS_ROOT_WEB_DIR" -eq 1 ]; then',
    '  # Domain root deployment: remove any subdirectory router base overrides from .env files',
    '  sed -i -E \'/^[[:space:]]*VITE_ROUTER_BASE[[:space:]]*=/d\' "$DIR/.env" "$DIR/.env.production" "$DIR/.env.local" 2>/dev/null || true',
    'fi',
  );

  if (preDeploy.trim()) lines.push('', 'echo "__STEP__ Pre-deploy commands"', preDeploy);
  if (postDeploy.trim()) lines.push('', 'echo "__STEP__ Post-deploy commands"', postDeploy);

  // Automatic post-build normalization and Windows/Apache guardrails
  lines.push(
    '',
    '# -------------------------------------------------------------',
    '# Automatic post-build normalization & Apache routing guardrails',
    '# -------------------------------------------------------------',
    'IS_WIN=0',
    'case "$(uname -s 2>/dev/null || echo Windows)" in',
    '  MINGW*|MSYS*|CYGWIN*|*Windows*) IS_WIN=1 ;;',
    '  *) [ -d "/c/xampp" ] && IS_WIN=1 || true ;;',
    'esac',
    '',
    '# Sync compiled assets into web root if dist/, build/, or current/dist/ was produced',
    'if [ -d "$DIR/dist" ] && [ -f "$DIR/dist/index.html" ]; then',
    '  cp -rf "$DIR/dist/"* "$DIR/" 2>/dev/null || true',
    'elif [ -d "$DIR/build" ] && [ -f "$DIR/build/index.html" ]; then',
    '  cp -rf "$DIR/build/"* "$DIR/" 2>/dev/null || true',
    'elif [ -d "$DIR/current/dist" ] && [ -f "$DIR/current/dist/index.html" ]; then',
    '  cp -rf "$DIR/current/dist/"* "$DIR/" 2>/dev/null || true',
    'fi',
    '',
    '# 1. Universal SPA Auto-Detection, <base href> Injection & .htaccess Routing (Linux & Windows)',
    'if [ -f "$DIR/package.json" ] && grep -qiE \'vite|react-scripts|webpack|@tailwindcss|vue\' "$DIR/package.json" && ! grep -qiE \'"start"[[:space:]]*:[[:space:]]*"node \' "$DIR/package.json" 2>/dev/null; then',
    '  if [ "$IS_ROOT_WEB_DIR" -eq 1 ]; then',
    '    # Domain root deployment: ensure <base href="/" /> is present in index.html',
    '    if [ -f "$DIR/index.html" ]; then',
    '      if grep -q "<base" "$DIR/index.html"; then',
    '        sed -i -E \'s/<base[^>]*>/<base href="\\/" \\/>/g\' "$DIR/index.html" 2>/dev/null || true',
    '      else',
    '        sed -i -E \'s/<head>/<head>\\n    <base href="\\/" \\/>/g\' "$DIR/index.html" 2>/dev/null || true',
    '      fi',
    '    fi',
    '    if [ ! -f "$DIR/.htaccess" ]; then',
    '      cat << \'HTACCESS_ROOT_EOF\' > "$DIR/.htaccess"',
    'Options -Indexes',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  RewriteBase /',
    '  # Bypass /api requests so Node.js backend handles them',
    '  RewriteRule ^api(/.*)?$ - [L]',
    '  # Block public access to private source code',
    '  RewriteRule ^(src|\\.git|node_modules|package.*\\.json|vite\\.config\\.js|\\.env.*|README\\.md) - [F,L]',
    '  # Allow direct access to existing files and directories',
    '  RewriteCond %{REQUEST_FILENAME} -f [OR]',
    '  RewriteCond %{REQUEST_FILENAME} -d',
    '  RewriteRule ^ - [L]',
    '  # Direct access to index.html',
    '  RewriteRule ^index\\.html$ - [L]',
    '  # Route all other URLs to index.html for SPA client-side routing',
    '  RewriteRule . index.html [L]',
    '</IfModule>',
    'HTACCESS_ROOT_EOF',
    '    fi',
    '  else',
    '    # Subdirectory deployment (e.g. /app-deploy, /appmanager)',
    '    if [ -f "$DIR/index.html" ]; then',
    '      if grep -q "<base" "$DIR/index.html"; then',
    '        sed -i -E \'s/<base[^>]*>/<base href="\\/\'"$DIR_BASENAME"\'\\/" \\/>/g\' "$DIR/index.html" 2>/dev/null || true',
    '      else',
    '        sed -i -E \'s/<head>/<head>\\n    <base href="\\/\'"$DIR_BASENAME"\'\\/" \\/>/g\' "$DIR/index.html" 2>/dev/null || true',
    '      fi',
    '    fi',
    '    if [ ! -f "$DIR/.htaccess" ]; then',
    '      cat << HTACCESS_SPA_EOF > "$DIR/.htaccess"',
    'Options -Indexes',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  RewriteBase /${DIR_BASENAME}/',
    '  # Block public access to private source code',
    '  RewriteRule ^(src|\\.git|node_modules|package.*\\.json|vite\\.config\\.js|\\.env.*|README\\.md) - [F,L]',
    '  # Allow direct access to existing files and directories',
    '  RewriteCond %{REQUEST_FILENAME} -f [OR]',
    '  RewriteCond %{REQUEST_FILENAME} -d',
    '  RewriteRule ^ - [L]',
    '  # Direct access to index.html',
    '  RewriteRule ^index\\.html$ - [L]',
    '  # Route all other URLs to index.html for SPA client-side routing',
    '  RewriteRule . index.html [L]',
    '</IfModule>',
    'HTACCESS_SPA_EOF',
    '    fi',
    '  fi',
    '  # Set permissions for LiteSpeed / Apache',
    '  chmod 755 "$DIR" 2>/dev/null || true',
    '  chmod 644 "$DIR/.htaccess" "$DIR/index.html" 2>/dev/null || true',
    '  [ -d "$DIR/assets" ] && chmod 755 "$DIR/assets" && chmod 644 "$DIR/assets/"* 2>/dev/null || true',
    'fi',
    '',
    '# 2. Windows Node.js API Auto-Detection, PowerShell Background Daemon & Apache Reverse Proxy',
    'if [ "$IS_WIN" -eq 1 ]; then',
    '  if [ -f "$DIR/package.json" ] && ( [ -f "$DIR/src/server.js" ] || [ -f "$DIR/server.js" ] || [ -f "$DIR/index.js" ] || [ -f "$DIR/app.js" ] || grep -qiE \'"start"[[:space:]]*:[[:space:]]*"node \' "$DIR/package.json" 2>/dev/null ) && ! grep -qiE \'vite|react-scripts|@tailwindcss\' "$DIR/package.json" 2>/dev/null; then',
    '    NODE_PORT=$(grep -E \'^[[:space:]]*PORT=\' "$DIR/.env" 2>/dev/null | head -n 1 | cut -d \'=\' -f 2 | tr -d \'"\\r\\n \' || echo "")',
    '    [ -z "$NODE_PORT" ] && NODE_PORT="8000"',
    '    cat << HTACCESS_NODE_EOF > "$DIR/.htaccess"',
    'Options -Indexes',
    'DirectoryIndex disabled',
    '',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  RewriteCond %{HTTP:Upgrade} websocket [NC]',
    '  RewriteCond %{HTTP:Connection} upgrade [NC]',
    '  RewriteRule ^(.*)$ ws://127.0.0.1:${NODE_PORT}/\$1 [P,L]',
    '  RewriteRule ^(index\\.php)?$ http://127.0.0.1:${NODE_PORT}/ [P,L]',
    '  RewriteRule ^(.*)$ http://127.0.0.1:${NODE_PORT}/\$1 [P,L,QSA]',
    '</IfModule>',
    'HTACCESS_NODE_EOF',
    '',
    '    ENTRY="src/server.js"',
    '    [ -f "$DIR/server.js" ] && ENTRY="server.js"',
    '    [ -f "$DIR/index.js" ] && ENTRY="index.js"',
    '    [ -f "$DIR/app.js" ] && ENTRY="app.js"',
    '',
    '    cat << \'PS_RUNNER_EOF\' > "$DIR/run_service.ps1"',
    'param([int]$port = 8000, [string]$entry = "index.js")',
    '$ErrorActionPreference = "SilentlyContinue"',
    'Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {',
    '    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue',
    '}',
    'Start-Sleep -Milliseconds 600',
    '$node = "C:\\Program Files\\nodejs\\node.exe"',
    'if (-not (Test-Path $node)) {',
    '    $node = (Get-Command node -ErrorAction SilentlyContinue).Source',
    '}',
    'if (-not $node) { $node = "node" }',
    'Start-Process -FilePath $node -ArgumentList $entry -WorkingDirectory $PSScriptRoot -WindowStyle Hidden',
    'Write-Host "Started service on port $port."',
    'PS_RUNNER_EOF',
    '',
    '    echo "Starting Node.js service via PowerShell runner on port $NODE_PORT..."',
    '    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$DIR/run_service.ps1" -port "$NODE_PORT" -entry "$ENTRY" 2>/dev/null || true',
    '  fi',
    'fi',
  );
  lines.push('');

  return lines.join('\n');
}

/** Stops a script and everything it started, from a second SSH channel. */
const killTreeScript = (pid) =>
  [
    'kt() { for c in $(pgrep -P "$1"); do kt "$c"; done; kill -TERM "$1" 2>/dev/null || true; }',
    `kt ${Number(pid)}`,
  ].join('\n');

module.exports = { shellQuote, envLine, buildScript, killTreeScript };
