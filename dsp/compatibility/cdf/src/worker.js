'use strict';

const { parseStrictJson } = require('./strict-json');
const { execute, safeFailure } = require('./collector');

const MAX_INPUT_BYTES = 65_536;

function runWorker({ executeRequest = execute } = {}) {
  let chunks = [];
  let bytes = 0;
  let finished = false;
  let terminating = false;
  const controller = new AbortController();
  const terminate = () => { terminating = true; controller.abort(); };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  const respond = value => {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  process.stdin.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) {
      chunks = [];
      respond(safeFailure(Object.assign(new Error('invalid_request'), { code: 'invalid_request' })));
      process.stdin.destroy();
    } else chunks.push(chunk);
  });
  process.stdin.on('error', () => respond(safeFailure(Object.assign(new Error('invalid_request'), { code: 'invalid_request' }))));
  process.stdin.on('end', async () => {
    if (finished) return;
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      chunks = [];
      if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) {
        throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
      }
      let request;
      try { request = parseStrictJson(text.slice(0, -1)); }
      catch { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' }); }
      respond(await executeRequest(request, { signal: controller.signal }));
    } catch (error) { respond(safeFailure(error)); }
    finally {
      process.removeListener('SIGTERM', terminate);
      process.removeListener('SIGINT', terminate);
      if (terminating) process.exitCode = 143;
    }
  });
}

module.exports = { MAX_INPUT_BYTES, runWorker };
