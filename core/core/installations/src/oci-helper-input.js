'use strict';

const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const { parseStrictJson } = require('../../../shared/gateway/strict-json');

function fail() {
  throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' });
}

// Read at most limit + 1 bytes, including when stdin is an unbounded pipe.
// Checking size after readFileSync(0) does not bound memory consumption.
function readHelperRequest(fd, limit) {
  if (!Number.isSafeInteger(limit) || limit < 3 || limit > 256 * 1024) fail();
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length <= limit) {
    const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
    if (length > limit) fail();
  }
  if (length < 3) fail();
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n') || /[\r\0]/.test(raw)) fail();
    return parseStrictJson(raw.slice(0, -1));
  } catch { fail(); }
}

module.exports = { readHelperRequest };
