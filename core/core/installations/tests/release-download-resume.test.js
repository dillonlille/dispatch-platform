'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { sha } = require('../src/release-delivery-contract');
const { createGitHubReleaseSource } = require('../src/release-delivery-github');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-resume-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('complete verified package');
  return { file: path.join(root, 'download.partial'), bytes, expected: { size: bytes.length, sha256: sha(bytes) },
    asset: { id: 10, state: 'uploaded', size: bytes.length, digest: `sha256:${sha(bytes)}` } };
}
async function interrupt(f) {
  let reads = 0;
  const source = createGitHubReleaseSource({ token: 'fixture', fetcher: async () => new Response(new ReadableStream({
    pull(controller) { if (reads++ === 0) controller.enqueue(f.bytes.subarray(0, 8)); else controller.error(Error('connection lost')); },
  })) });
  await assert.rejects(source.download(f.asset, f.file, f.expected));
  assert.equal(fs.statSync(f.file).size, 8);
}
for (const range of [true, false]) test(`interrupted download ${range ? 'resumes' : 'restarts if range is ignored'} and verifies the whole file`, async t => {
  const f = fixture(t); await interrupt(f); const calls = [];
  const source = createGitHubReleaseSource({ token: 'fixture', fetcher: async (url, options) => {
    calls.push(options); return new Response(range ? f.bytes.subarray(8) : f.bytes, range ? { status: 206, headers: { 'content-range': `bytes 8-${f.bytes.length - 1}/${f.bytes.length}` } } : {});
  } });
  await source.download(f.asset, f.file, f.expected);
  assert.equal(calls[0].headers.Range, 'bytes=8-'); assert.deepEqual(fs.readFileSync(f.file), f.bytes);
});
test('wrong ranges and corrupted resumed bytes are discarded', async t => {
  const f = fixture(t); await interrupt(f);
  const wrong = createGitHubReleaseSource({ token: 'fixture', fetcher: async () => new Response(f.bytes.subarray(8), { status: 206, headers: { 'content-range': 'bytes 0-9/10' } }) });
  await assert.rejects(wrong.download(f.asset, f.file, f.expected), { code: 'release_asset_invalid' }); assert.equal(fs.existsSync(f.file), false);
  await interrupt(f); fs.writeFileSync(f.file, 'tampered');
  const corrupt = createGitHubReleaseSource({ token: 'fixture', fetcher: async () => new Response(f.bytes.subarray(8), { status: 206, headers: { 'content-range': `bytes 8-${f.bytes.length - 1}/${f.bytes.length}` } }) });
  await assert.rejects(corrupt.download(f.asset, f.file, f.expected), { code: 'release_checksum_failed' }); assert.equal(fs.existsSync(f.file), false);
});
test('partials from another asset are never appended and symlinks are rejected', async t => {
  const f = fixture(t); await interrupt(f); let headers;
  const source = createGitHubReleaseSource({ token: 'fixture', fetcher: async (_, options) => { headers = options.headers; return new Response(f.bytes); } });
  await source.download({ ...f.asset, id: 11 }, f.file, f.expected); assert.equal(headers.Range, undefined);
  fs.unlinkSync(f.file); fs.symlinkSync('/etc/passwd', f.file);
  await assert.rejects(source.download(f.asset, f.file, f.expected), { code: 'unsafe_release_storage' });
});
