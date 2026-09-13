'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomic } = require('../src/release-delivery-files');

test('atomic public receipts remain readable under the root worker private umask', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-receipt-mode-'));
  const previous = process.umask(0o077);
  try {
    const receipt = path.join(root, 'rollout.cleanup.json');
    atomic(receipt, { status: 'completed' }, 0o644);
    assert.equal(fs.statSync(receipt).mode & 0o777, 0o644);
    assert.equal(JSON.parse(fs.readFileSync(receipt)).status, 'completed');
    atomic(path.join(root, 'private.json'), { secret: 'private' });
    assert.equal(fs.statSync(path.join(root, 'private.json')).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
