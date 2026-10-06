// Turns a deploy's output into numbered lines, saved to MySQL and published to Redis in batches
// (every 250 ms or 100 lines, whichever comes first). The worker is the only writer.
const prisma = require('../models/prisma');
const { channels, publish } = require('./events');
const { logger } = require('./logger');

const MAX_LINE_BYTES = 4096;
const MAX_LINES = 50_000;

function capLine(line) {
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  return `${Buffer.from(line).subarray(0, MAX_LINE_BYTES).toString('utf8')} …[line cut at 4 KB]`;
}

class LogStream {
  /**
   * filter(stream, line) may return null to hide a line, or { stream, line } to replace it.
   */
  constructor(deploymentId, { filter, flushMs = 250, maxBatch = 100, maxLines = MAX_LINES } = {}) {
    this.deploymentId = deploymentId;
    this.filter = filter;
    this.flushMs = flushMs;
    this.maxBatch = maxBatch;
    this.maxLines = maxLines;
    this.seq = 0;
    this.cut = false;
    this.partial = { STDOUT: '', STDERR: '' };
    this.buffer = [];
    this.timer = null;
    this.chain = Promise.resolve();
  }

  /** Raw output from the server; may hold partial lines. */
  write(stream, chunk) {
    const text = this.partial[stream] + chunk.toString('utf8');
    const lines = text.split('\n');
    this.partial[stream] = lines.pop();
    for (const line of lines) this.line(stream, line.replace(/\r$/, ''));
  }

  /** A line from the portal itself, e.g. "Connecting to web1". */
  system(text) {
    this.add('SYSTEM', text);
  }

  line(stream, text) {
    const result = this.filter ? this.filter(stream, text) : { stream, line: text };
    if (result) this.add(result.stream, result.line);
  }

  add(stream, text) {
    if (this.seq >= this.maxLines) {
      if (!this.cut) {
        this.cut = true;
        this.push('SYSTEM', `Log cut at ${this.maxLines.toLocaleString('en')} lines; the deploy keeps running`);
      }
      return;
    }
    this.push(stream, capLine(text));
  }

  push(stream, line) {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, stream, line, at: new Date() });
    if (this.buffer.length >= this.maxBatch) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  /** Saves and publishes everything buffered. Batches go out strictly in order. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buffer.splice(0);
    if (batch.length === 0) return this.chain;

    this.chain = this.chain.then(async () => {
      try {
        await prisma.deploymentLog.createMany({
          data: batch.map((l) => ({
            deploymentId: this.deploymentId,
            seq: l.seq,
            stream: l.stream,
            line: l.line,
            createdAt: l.at,
          })),
        });
      } catch (err) {
        logger.error({ err, deploymentId: this.deploymentId }, 'saving log lines failed');
      }
      await publish(channels.logs(this.deploymentId), { id: this.deploymentId, lines: batch });
    });
    return this.chain;
  }

  /** Writes out any unfinished lines and waits for every batch to be saved. */
  async close() {
    for (const stream of ['STDOUT', 'STDERR']) {
      if (this.partial[stream]) this.line(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
    await this.flush();
  }
}

module.exports = { LogStream, MAX_LINES, MAX_LINE_BYTES };
