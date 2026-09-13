'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readHelperRequest } = require('../src/oci-helper-input');

test('helper input is bounded before allocation and rejects ambiguous JSON and invalid UTF-8', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-helper-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'input');
  const read = input => {
    fs.writeFileSync(file, input);
    const fd = fs.openSync(file, 'r');
    try { return readHelperRequest(fd, 64); } finally { fs.closeSync(fd); }
  };
  assert.deepEqual(read('{"ok":true}\n'), { ok: true });
  for (const input of ['x'.repeat(65), '{"a":1,"a":2}\n', '{}\n{}\n', '{}', '{}\r\n',
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d, 0x0a])]) {
    assert.throws(() => read(input), { code: 'runtime_boundary_violation' });
  }
});
