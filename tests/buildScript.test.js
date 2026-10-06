require('./setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildScript, envLine, killTreeScript, shellQuote } = require('../utils/buildScript');

describe('shellQuote', () => {
  it('wraps values in single quotes and escapes single quotes', () => {
    assert.equal(shellQuote('main'), `'main'`);
    assert.equal(shellQuote(`it's`), `'it'\\''s'`);
    assert.equal(shellQuote('$(rm -rf /); `id`'), `'$(rm -rf /); \`id\`'`);
  });
});

describe('envLine', () => {
  it('double-quotes values and escapes backslashes, quotes and newlines', () => {
    assert.equal(envLine('A', 'plain'), 'A="plain"');
    assert.equal(envLine('A', 'say "hi"\\n\nnext'), 'A="say \\"hi\\"\\\\n\\nnext"');
  });
});

describe('buildScript', () => {
  const base = { repoUrl: 'git@github.com:acme/shop.git', branch: 'main', path: '/var/www/shop' };

  it('quotes every value and starts with strict mode and the PID marker', () => {
    const script = buildScript({ ...base, sha: 'abc1234' });
    const lines = script.split('\n');
    assert.equal(lines[0], 'set -euo pipefail');
    assert.equal(lines[1], 'echo "__PID__ $$"');
    assert.equal(
      lines[2],
      `REPO='git@github.com:acme/shop.git'; BRANCH='main'; DIR='/var/www/shop'; SHA='abc1234'`,
    );
    assert.match(script, /__PREV__/);
    assert.match(script, /__COMMIT__/);
  });

  it('writes .env only when there are variables, without the values in plain text', () => {
    assert.doesNotMatch(buildScript(base), /\.env/);
    const script = buildScript({ ...base, envVars: { DB_PASSWORD: 'hunter2' } });
    assert.match(script, /base64 -d > \.env/);
    assert.match(script, /umask 077/);
    assert.ok(!script.includes('hunter2'));
  });

  it('adds pre- and post-deploy commands in order, skipping empty ones', () => {
    const script = buildScript({ ...base, preDeploy: 'npm ci', postDeploy: 'pm2 reload shop' });
    assert.ok(script.indexOf('npm ci') < script.indexOf('pm2 reload shop'));
    assert.doesNotMatch(buildScript({ ...base, preDeploy: '  ' }), /Pre-deploy/);
  });
});

describe('killTreeScript', () => {
  it('only ever uses a number as the pid', () => {
    assert.match(killTreeScript('42; rm -rf /'), /kt NaN$/);
    assert.match(killTreeScript(42), /kt 42$/);
  });
});
