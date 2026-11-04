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

  // Automatic post-build normalization for SPA assets & Apache routing
  lines.push(
    '',
    '# Automatic post-build normalization for SPA assets & Apache routing',
    'if [ -f "$DIR/index.html" ]; then',
    '  sed -i -E \'s/(href|src)="\\/assets\\//\\1=".\\/assets\\//g\' "$DIR/index.html" 2>/dev/null || true',
    '  sed -i -E \'s/(href|src)="\\/favicon/\\1=".\\/favicon/g\' "$DIR/index.html" 2>/dev/null || true',
    'fi',
    'if [ -f "$DIR/dist/index.html" ]; then',
    '  sed -i -E \'s/(href|src)="\\/assets\\//\\1=".\\/assets\\//g\' "$DIR/dist/index.html" 2>/dev/null || true',
    '  sed -i -E \'s/(href|src)="\\/favicon/\\1=".\\/favicon/g\' "$DIR/dist/index.html" 2>/dev/null || true',
    'fi',
    'if [ -f "$DIR/.htaccess" ]; then',
    '  sed -i -E \'/^[[:space:]]*RewriteBase[[:space:]]+\\/[[:space:]]*$/d\' "$DIR/.htaccess" 2>/dev/null || true',
    '  sed -i -E \'s/RewriteRule \\. \\/index\\.html \\[L\\]/RewriteRule . index.html [L]/g\' "$DIR/.htaccess" 2>/dev/null || true',
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
