require('./setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const pino = require('pino');
const { redactPaths } = require('../utils/logger');

describe('log redaction', () => {
  it('hides secrets at the top level, one level down and in request headers', () => {
    const lines = [];
    const log = pino(
      { redact: { paths: redactPaths, censor: '[REDACTED]' } },
      { write: (line) => lines.push(line) },
    );

    log.info(
      {
        password: 'p@ss',
        server: { privateKey: '-----BEGIN KEY-----', host: 'web1' },
        req: { headers: { authorization: 'Bearer tok', cookie: 'access=tok' } },
      },
      'test',
    );

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.password, '[REDACTED]');
    assert.deepEqual(entry.server, { privateKey: '[REDACTED]', host: 'web1' });
    assert.deepEqual(entry.req.headers, { authorization: '[REDACTED]', cookie: '[REDACTED]' });
  });
});
