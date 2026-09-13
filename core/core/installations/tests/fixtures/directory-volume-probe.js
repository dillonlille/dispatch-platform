'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.DISPATCH_DATA_ROOT;
const size = fs.statfsSync(root), cap = size.blocks * size.bsize;
assert.ok(cap < 80 * 1024 ** 2, 'acceptance requires a small isolated volume');
const file = path.join(root, 'quota-fill'), fd = fs.openSync(file, 'w', 0o600);
let limited = false, written = 0;
try {
  const block = Buffer.alloc(1024 ** 2, 65);
  while (written < cap + block.length) written += fs.writeSync(fd, block);
} catch (error) { if (error.code !== 'ENOSPC') throw error; limited = true; }
finally { fs.closeSync(fd); fs.unlinkSync(file); }
assert.equal(limited, true);
fs.writeFileSync(path.join(root, 'quota-retained'), 'synthetic quota recovery', { mode: 0o600 });
const retained = fs.openSync(path.join(root, 'quota-retained'), 'r'); fs.fsyncSync(retained); fs.closeSync(retained);
assert.equal(fs.statSync(root).dev, fs.statSync(path.dirname(root)).dev);
process.stdout.write(JSON.stringify({ ok: true, limited, writtenBytes: written, capacityBytes: cap, storageIdentity: true }) + '\n');
