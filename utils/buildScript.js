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
function buildScript({ repoUrl, branch, path, sha, envVars = {}, preDeploy = '', postDeploy = '' }) {
  const normalizedPath = normalizeDeploymentPath(path);
  const lines = [
    'set -euo pipefail',
    'echo "__PID__ $$"',
    'export GIT_TERMINAL_PROMPT=0',
    'export GCM_INTERACTIVE=never',
    'export GIT_ASKPASS=""',
    'export MSYS_NO_PATHCONV=1',
    'export MSYS2_ARG_CONV_EXCL="*"',
    'export PATH="/c/Program Files/nodejs:/c/Program Files/Git/cmd:/c/Program Files/Git/bin:$PATH"',
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
    'IS_ROOT_WEB_DIR=0',
    'case "$DIR_BASENAME" in',
    '  public_html|html|www|public|htdocs|web) IS_ROOT_WEB_DIR=1 ;;',
    'esac',
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
    '# Sync compiled assets into web root if dist/ or build/ was produced',
    'if [ -d "$DIR/dist" ] && [ -f "$DIR/dist/index.html" ]; then',
    '  cp -rf "$DIR/dist/"* "$DIR/" 2>/dev/null || true',
    'elif [ -d "$DIR/build" ] && [ -f "$DIR/build/index.html" ]; then',
    '  cp -rf "$DIR/build/"* "$DIR/" 2>/dev/null || true',
    'fi',
    '',
    'if [ "$IS_WIN" -eq 1 ]; then',
    '  # 1. Windows React / Vite / Vue SPA Auto-Detection & Healing',
    '  if [ -f "$DIR/package.json" ] && grep -qiE \'vite|react-scripts|webpack|@tailwindcss\' "$DIR/package.json" && ! grep -qiE \'"start"[[:space:]]*:[[:space:]]*"node \' "$DIR/package.json" 2>/dev/null; then',
    '    if [ "$IS_ROOT_WEB_DIR" -eq 0 ]; then',
    '      # Subdirectory deployment on Windows Apache (e.g. /xampp/htdocs/app-deploy)',
    '      # Inject <base href="/<subdir>/"> into index.html so all nested route assets resolve properly',
    '      if [ -f "$DIR/index.html" ]; then',
    '        if grep -q "<base" "$DIR/index.html"; then',
    '          sed -i -E \'s/<base[^>]*>/<base href="\\/\'"$DIR_BASENAME"\'\\/" \\/>/g\' "$DIR/index.html" 2>/dev/null || true',
    '        else',
    '          sed -i -E \'s/<head>/<head>\\n    <base href="\\/\'"$DIR_BASENAME"\'\\/" \\/>/g\' "$DIR/index.html" 2>/dev/null || true',
    '        fi',
    '      fi',
    '      # Write Apache .htaccess for subdirectory SPA routing',
    '      cat << HTACCESS_SPA_EOF > "$DIR/.htaccess"',
    'Options -Indexes',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  RewriteBase /${DIR_BASENAME}/',
    '  RewriteRule ^index\\.html$ - [L]',
    '  RewriteCond %{REQUEST_FILENAME} !-f',
    '  RewriteCond %{REQUEST_FILENAME} !-d',
    '  RewriteRule . index.html [L]',
    '</IfModule>',
    'HTACCESS_SPA_EOF',
    '    else',
    '      # Domain root deployment on Windows Apache',
    '      cat << HTACCESS_ROOT_EOF > "$DIR/.htaccess"',
    'Options -Indexes',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  RewriteBase /',
    '  RewriteRule ^index\\.html$ - [L]',
    '  RewriteCond %{REQUEST_FILENAME} !-f',
    '  RewriteCond %{REQUEST_FILENAME} !-d',
    '  RewriteRule . index.html [L]',
    '</IfModule>',
    'HTACCESS_ROOT_EOF',
    '    fi',
    '  fi',
    '',
    '  # 2. Windows Node.js API Auto-Detection & Apache Reverse Proxy Guardrail',
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
    '    WIN_DIR="C:${DIR#/c}"',
    '    WIN_DIR="${WIN_DIR//\\//\\\\}"',
    '    WIN_ENTRY="${ENTRY//\\//\\\\}"',
    '    TASK_NAME="Task_${DIR_BASENAME}"',
    '    cat << START_CMD_EOF > "$DIR/start_service.cmd"',
    '@echo off',
    'cd /d "${WIN_DIR}"',
    '"C:\\Program Files\\nodejs\\node.exe" ${WIN_ENTRY} >> "${WIN_DIR}\\server.log" 2>&1',
    'START_CMD_EOF',
    '    powershell.exe -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort ${NODE_PORT} -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue" 2>/dev/null || true',
    '    schtasks.exe //query //tn "$TASK_NAME" >/dev/null 2>&1 || schtasks.exe //create //tn "$TASK_NAME" //tr "${WIN_DIR}\\start_service.cmd" //sc onstart //f >/dev/null 2>&1 || true',
    '    echo "Starting Node.js service ($TASK_NAME) on port $NODE_PORT..."',
    '    schtasks.exe //run //tn "$TASK_NAME" 2>/dev/null || powershell.exe -NoProfile -Command "Start-Process cmd.exe -ArgumentList \'/c\', \'${WIN_DIR}\\start_service.cmd\' -WorkingDirectory \'${WIN_DIR}\' -WindowStyle Hidden" 2>/dev/null || true',
    '  fi',
    'else',
    '  # Linux fallback normalization',
    '  if [ "$IS_ROOT_WEB_DIR" -eq 1 ]; then',
    '    # Root domain: Ensure .htaccess routes SPA and protects sources',
    '    cat << \'HTACCESS_LINUX_ROOT\' > "$DIR/.htaccess"',
    'Options -Indexes',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  RewriteBase /',
    '  RewriteRule ^api(/.*)?$ - [L]',
    '  RewriteRule ^(src|\\.git|node_modules|package.*\\.json|vite\\.config\\.js|\\.env.*|README\\.md) - [F,L]',
    '  RewriteCond %{REQUEST_FILENAME} -f [OR]',
    '  RewriteCond %{REQUEST_FILENAME} -d',
    '  RewriteRule ^ - [L]',
    '  RewriteRule ^index\\.html$ - [L]',
    '  RewriteRule . index.html [L]',
    '</IfModule>',
    'HTACCESS_LINUX_ROOT',
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
