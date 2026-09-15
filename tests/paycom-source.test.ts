import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('installed archived Paycom adapter and native input retain their source hashes', () => {
  const root = 'integrations/paycom/provider/auth';
  const sources = JSON.parse(fs.readFileSync(`${root}/source-files.json`, 'utf8')) as {
    file: string;
    sourceSha256: string;
    changes: string[];
  }[];
  for (const source of sources.filter(
    (source) => !source.changes.length || source.file === 'adapter.js',
  )) {
    const file = fs.readFileSync(`${root}/${source.file}`);
    const original =
      source.file === 'adapter.js'
        ? file.toString().replaceAll('"./cdp.js"', '"../dependencies/dispatch-sdk/node/cdp.js"')
        : file;
    assert.equal(digest(original), source.sourceSha256, source.file);
  }
});
