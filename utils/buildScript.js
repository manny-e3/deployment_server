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
    'git config --global --add safe.directory "$DIR" 2>/dev/null || true',
    // Clean up any stale index locks left by interrupted/canceled previous deployments
    'rm -f .git/index.lock .git/shallow.lock',
    // Verify valid git directory exists (with HEAD); if corrupted or missing, re-initialize cleanly
    'if git rev-parse --git-dir >/dev/null 2>&1; then',
    '  echo "__PREV__ $(git rev-parse HEAD 2>/dev/null || echo none)"',
    'else',
    '  echo "__PREV__ none"',
    '  rm -rf .git',
    '  git init -q',
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
    'DIR_BASENAME=$(basename "$DIR")',
    '',
    'if [ "$IS_WIN" -eq 1 ]; then',
    '  # 1. Windows React / Vite / Vue SPA Auto-Detection & Healing',
    '  if [ -f "$DIR/package.json" ] && grep -qiE \'vite|react-scripts|webpack|@tailwindcss\' "$DIR/package.json" && ! grep -qiE \'"start"[[:space:]]*:[[:space:]]*"node \' "$DIR/package.json" 2>/dev/null; then',
    '    # Restore pristine index.html before building if previously overwritten',
    '    git checkout -- index.html 2>/dev/null || true',
    '    # Auto-inject basename into BrowserRouter if missing in code',
    '    for RF in "$DIR/src/main.jsx" "$DIR/src/main.tsx" "$DIR/src/main.js" "$DIR/src/App.jsx" "$DIR/src/App.tsx" "$DIR/src/App.js" "$DIR/src/index.jsx" "$DIR/src/index.js"; do',
    '      if [ -f "$RF" ] && grep -q "<BrowserRouter" "$RF" && ! grep -q "basename" "$RF"; then',
    '        sed -i -E \'s/<BrowserRouter([ >])/<BrowserRouter basename="\\/\'"$DIR_BASENAME"\'"\\1/g\' "$RF" 2>/dev/null || true',
    '      fi',
    '    done',
    '    # If dist/ or build/ does not exist, compile the bundle',
    '    if [ ! -d "$DIR/dist" ] && [ ! -d "$DIR/build" ] || [ -f "$DIR/package.json" ]; then',
    '      echo "__STEP__ Compiling frontend production bundle..."',
    '      (npm install && (VITE_ROUTER_BASE="/${DIR_BASENAME}" npm run build -- --base=./ 2>/dev/null || npm run build 2>/dev/null || true)) || true',
    '    fi',
    '    # Restore source files so working tree stays clean',
    '    git checkout -- "$DIR/src" 2>/dev/null || true',
    '    # Sync compiled bundle into web root so Apache serves compiled assets rather than raw source',
    '    if [ -d "$DIR/dist" ] && [ -f "$DIR/dist/index.html" ]; then',
    '      cp -rf "$DIR/dist/"* "$DIR/" 2>/dev/null || true',
    '    elif [ -d "$DIR/build" ] && [ -f "$DIR/build/index.html" ]; then',
    '      cp -rf "$DIR/build/"* "$DIR/" 2>/dev/null || true',
    '    fi',
    '    # Normalize relative asset paths for Apache subdirectory hosting',
    '    if [ -f "$DIR/index.html" ]; then',
    '      sed -i -E \'s/(href|src)="\\/assets\\//\\1=".\\/assets\\//g\' "$DIR/index.html" 2>/dev/null || true',
    '      sed -i -E \'s/(href|src)="\\/favicon/\\1=".\\/favicon/g\' "$DIR/index.html" 2>/dev/null || true',
    '      sed -i -E \'s/<base href="\\/"/<base href=".\\/"/g\' "$DIR/index.html" 2>/dev/null || true',
    '      sed -i -E \'s/(href|src)="\\/[a-zA-Z0-9_-]+\\/assets\\//\\1=".\\/assets\\//g\' "$DIR/index.html" 2>/dev/null || true',
    '    fi',
    '    # Ensure .htaccess for SPA client-side routing',
    '    cat << HTACCESS_SPA_EOF > "$DIR/.htaccess"',
    'Options -Indexes',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  RewriteBase /${DIR_BASENAME}/',
    '  # If dist directory exists, rewrite static requests to dist/',
    '  RewriteCond %{DOCUMENT_ROOT}/${DIR_BASENAME}/dist/\\$1 -f',
    '  RewriteRule ^(.*)$ dist/\\$1 [L]',
    '  # SPA client-side routing fallback to dist/index.html',
    '  RewriteCond %{REQUEST_FILENAME} !-f',
    '  RewriteCond %{REQUEST_FILENAME} !-d',
    '  RewriteCond %{DOCUMENT_ROOT}/${DIR_BASENAME}/dist/index.html -f',
    '  RewriteRule . dist/index.html [L]',
    '  # Standard fallback to root index.html',
    '  RewriteRule ^index\\.html$ - [L]',
    '  RewriteCond %{REQUEST_FILENAME} !-f',
    '  RewriteCond %{REQUEST_FILENAME} !-d',
    '  RewriteRule . index.html [L]',
    '</IfModule>',
    'HTACCESS_SPA_EOF',
    '  fi',
    '',
    '  # 2. Windows Node.js API Auto-Detection & Apache Reverse Proxy Guardrail',
    '  if [ -f "$DIR/package.json" ] && ( [ -f "$DIR/src/server.js" ] || [ -f "$DIR/server.js" ] || [ -f "$DIR/index.js" ] || [ -f "$DIR/app.js" ] || grep -qiE \'"start"[[:space:]]*:[[:space:]]*"node \' "$DIR/package.json" 2>/dev/null ) && ! grep -qiE \'vite|react-scripts|@tailwindcss\' "$DIR/package.json" 2>/dev/null; then',
    '    NODE_PORT=$(grep -E \'^[[:space:]]*PORT=\' "$DIR/.env" 2>/dev/null | head -n 1 | cut -d \'=\' -f 2 | tr -d \'"\\r\\n \' || echo "")',
    '    [ -z "$NODE_PORT" ] && NODE_PORT="8000"',
    '    # Ensure Apache reverse proxy is active and directory browsing is disabled',
    '    cat << HTACCESS_NODE_EOF > "$DIR/.htaccess"',
    'Options -Indexes',
    'DirectoryIndex disabled',
    '',
    '<IfModule mod_rewrite.c>',
    '  RewriteEngine On',
    '  # WebSocket upgrade',
    '  RewriteCond %{HTTP:Upgrade} websocket [NC]',
    '  RewriteCond %{HTTP:Connection} upgrade [NC]',
    '  RewriteRule ^(.*)$ ws://127.0.0.1:${NODE_PORT}/\$1 [P,L]',
    '  # Root and index.php rewrite to Node root /',
    '  RewriteRule ^(index\\.php)?$ http://127.0.0.1:${NODE_PORT}/ [P,L]',
    '  # HTTP Proxy to Node.js backend',
    '  RewriteRule ^(.*)$ http://127.0.0.1:${NODE_PORT}/\$1 [P,L,QSA]',
    '</IfModule>',
    'HTACCESS_NODE_EOF',
    '',
    '    # Ensure background service runner exists',
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
    '    cmd.exe /c "schtasks /query /tn \\"$TASK_NAME\\" >nul 2>&1 || schtasks /create /tn \\"$TASK_NAME\\" /tr \\"${WIN_DIR}\\start_service.cmd\\" /sc onstart /ru SYSTEM /f" 2>/dev/null || true',
    '    if ! netstat -ano 2>/dev/null | grep -q ":${NODE_PORT} "; then',
    '      echo "Starting Node.js service ($TASK_NAME) on port $NODE_PORT..."',
    '      cmd.exe /c "schtasks /run /tn \\"$TASK_NAME\\"" 2>/dev/null || true',
    '    fi',
    '  fi',
    'else',
    '  # Linux fallback normalization',
    '  if [ -f "$DIR/index.html" ]; then',
    '    sed -i -E \'s/(href|src)="\\/assets\\//\\1=".\\/assets\\//g\' "$DIR/index.html" 2>/dev/null || true',
    '    sed -i -E \'s/(href|src)="\\/favicon/\\1=".\\/favicon/g\' "$DIR/index.html" 2>/dev/null || true',
    '  fi',
    '  if [ -f "$DIR/dist/index.html" ]; then',
    '    sed -i -E \'s/(href|src)="\\/assets\\//\\1=".\\/assets\\//g\' "$DIR/dist/index.html" 2>/dev/null || true',
    '    sed -i -E \'s/(href|src)="\\/favicon/\\1=".\\/favicon/g\' "$DIR/dist/index.html" 2>/dev/null || true',
    '  fi',
    '  if [ -f "$DIR/.htaccess" ]; then',
    '    sed -i -E \'/^[[:space:]]*RewriteBase[[:space:]]+\\/[[:space:]]*$/d\' "$DIR/.htaccess" 2>/dev/null || true',
    '    sed -i -E \'s/RewriteRule \\. \\/index\\.html \\[L\\]/RewriteRule . index.html [L]/g\' "$DIR/.htaccess" 2>/dev/null || true',
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
