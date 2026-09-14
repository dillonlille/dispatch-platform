import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { allowedHost } from '../services/browsers/egress.js';
import { paycom } from '../integrations/paycom/manifest.js';
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
  const runner = fs.readFileSync('services/browsers/assistance/vendor/hermes-session.py');
  const source = JSON.parse(
    fs.readFileSync('services/browsers/assistance/vendor/source-files.json', 'utf8'),
  ).find((source: { file: string }) => source.file === 'hermes-session.py');
  assert.equal(digest(runner), source.sourceSha256);
});

test('Paycom subdomain policy permits archived CAPTCHA assets and rejects lookalike hosts', () => {
  for (const host of [
    'paycomonline.net',
    'www.paycomonline.net',
    'captcha-assethost.paycomonline.net',
    'nested.asset.paycomonline.net',
  ])
    assert(allowedHost(host, paycom.hosts), host);
  for (const host of [
    'paycomonline.net.evil.example',
    'evilpaycomonline.net',
    '127.0.0.1',
    'localhost',
    'paycomonline.net@evil.example',
  ])
    assert(!allowedHost(host, paycom.hosts), host);
});
