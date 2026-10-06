// Turns a target into the bash script the worker sends to `bash -l -s` on the server.
// Every value from the database goes through shellQuote(); nothing is ever joined into the
// SSH command line itself. Pre- and post-deploy commands are admin-written by design.

/** Wraps a value in single quotes, safely: it's'  ->  'it'\''s' */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** One line of a .env file, double-quoted so any value round-trips through dotenv. */
const envLine = (key, value) =>
  `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/**
 * Marker lines the worker reads and hides from the visible log:
 *   __PID__ <pid>            the script's own process id, used to stop it on cancel
 *   __STEP__ <name>          shown as a SYSTEM line
 *   __PREV__ <sha|none>      the commit before this deploy
 *   __COMMIT__ <sha> <msg>   the commit after it
 */
function buildScript({ repoUrl, branch, path, sha, envVars = {}, preDeploy = '', postDeploy = '' }) {
  const lines = [
    'set -euo pipefail',
    'echo "__PID__ $$"',
    `REPO=${shellQuote(repoUrl)}; BRANCH=${shellQuote(branch)}; DIR=${shellQuote(path)}; SHA=${shellQuote(sha ?? '')}`,
    '',
    'echo "__STEP__ Fetching $BRANCH"',
    // The previous commit is read before any checkout, so a first deploy reports "none".
    'mkdir -p "$DIR"',
    'if [ -d "$DIR/.git" ]; then',
    '  echo "__PREV__ $(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo none)"',
    'else',
    '  echo "__PREV__ none"',
    '  git -C "$DIR" init -q',
    '  git -C "$DIR" checkout -q -B "$BRANCH" 2>/dev/null || true',
    'fi',
    'cd "$DIR"',
    'git remote set-url origin "$REPO" 2>/dev/null || git remote add origin "$REPO"',
    'git fetch --prune origin "$BRANCH"',
    'git checkout -q -B "$BRANCH" "origin/$BRANCH"',
    'if [ -n "$SHA" ]; then git reset --hard "$SHA"; else git reset --hard "origin/$BRANCH"; fi',
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
    );
  }

  if (preDeploy.trim()) lines.push('', 'echo "__STEP__ Pre-deploy commands"', preDeploy);
  if (postDeploy.trim()) lines.push('', 'echo "__STEP__ Post-deploy commands"', postDeploy);
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
