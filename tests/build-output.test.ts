import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { replaceBuild } from '../tooling/build-output.js';
import { writeManifest } from '../tooling/artifact.js';

test('failed or invalid builds preserve the previous artifact; verified builds replace it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-build-'));
  const out = path.join(root, '.build');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'previous'), 'working');
  try {
    await assert.rejects(
      replaceBuild(out, async (dir) => {
        fs.writeFileSync(path.join(dir, 'partial'), 'unfinished');
        throw new Error('compiler failed');
      }),
      /compiler failed/,
    );
    await assert.rejects(
      replaceBuild(out, async (dir) => {
        writeManifest(dir, '0.1.0');
      }),
    );
    assert.equal(fs.readFileSync(path.join(out, 'previous'), 'utf8'), 'working');
    assert.deepEqual(fs.readdirSync(root), ['.build']);
    await replaceBuild(out, async (dir) => {
      for (const [file, contents] of Object.entries({
        'dashboard/index.html': 'ready',
        'services/rust/dispatch-backend': 'binary',
        'tooling/build-info.json': JSON.stringify({ commit: 'a'.repeat(40) }),
      })) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), contents);
      }
      writeManifest(dir, '0.1.0');
    });
    assert.equal(fs.existsSync(path.join(out, 'previous')), false);
    assert.equal(fs.readFileSync(path.join(out, 'dashboard/index.html'), 'utf8'), 'ready');
    assert.deepEqual(fs.readdirSync(root), ['.build']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
