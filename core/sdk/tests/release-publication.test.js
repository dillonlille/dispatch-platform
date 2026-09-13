'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { inventory, hash, verifyRelease } = require('dispatch-protocol/releases/package');
const { identity, packageRelease, context, assertVerifiedMain, assertUnusedVersion, assertComponentVersions, verifyPublication, publish } = require('../tooling/release-publication');
const selected = { product: 'core', repository: 'example/dispatch-core', version: '1.2.3', commit: 'a'.repeat(40) };

test('release package preserves candidate, binds source and verifies every packaged file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-release-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate');
  fs.mkdirSync(path.join(candidate, 'code'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'code/package.json'), JSON.stringify({ name: 'dispatch-core', version: '0.0.0' }));
  fs.writeFileSync(path.join(candidate, 'code/server.js'), 'module.exports = {};\n');
  const files = inventory(candidate);
  const manifest = { schemaVersion: 1, product: 'core', version: '0.0.0', channel: 'development', protocol: 1, minimumProtocol: 1,
    sourceDigest: hash(JSON.stringify(files)), packages: {}, plugins: [], files };
  const original = JSON.stringify(manifest);
  fs.writeFileSync(path.join(candidate, 'release.json'), original);
  const options = { ...selected, candidate, notes: 'x'.repeat(30) };
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  const result = packageRelease({ ...options, output: first });
  packageRelease({ ...options, output: second });
  assert.equal(fs.readFileSync(path.join(candidate, 'release.json'), 'utf8'), original);
  assert.deepEqual(fs.readFileSync(path.join(first, result.archive)), fs.readFileSync(path.join(second, result.archive)));
  const extracted = path.join(root, 'extracted');fs.mkdirSync(extracted);
  execFileSync('tar', ['-xzf', path.join(first, result.archive), '-C', extracted]);
  const released = verifyRelease(extracted, result.digest);
  assert.equal(released.channel, 'release');assert.equal(released.source.commit, selected.commit);
  assert.equal(JSON.parse(fs.readFileSync(path.join(extracted, 'code/package.json'))).version, selected.version);
  assert.equal(verifyPublication(first, selected).length, 4);
  fs.appendFileSync(path.join(first, result.archive), 'tampered');
  assert.throws(() => verifyPublication(first, selected), /digest_mismatch/);
  fs.appendFileSync(path.join(candidate, 'code/server.js'), 'tampered');
  assert.throws(() => packageRelease({ ...options, output: path.join(root, 'bad') }), /digest_mismatch/);
});

test('publication rejects invalid versions and another product repository', () => {
  for (const version of ['0.0.0', '01.2.3', '1.2', 'v1.2.3', '1.2.3;echo bad']) assert.throws(() => identity({ ...selected, version }), /identity_invalid/);
  assert.throws(() => identity({ ...selected, repository: 'example/dispatch-dsp' }), /identity_invalid/);
});

test('only an explicit main workflow dispatch at the selected checkout may publish', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-release-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dispatch-core' }));
  const env = { GITHUB_REPOSITORY: selected.repository, RELEASE_COMMIT: selected.commit, RELEASE_VERSION: selected.version,
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: selected.commit };
  assert.throws(() => context(root, env), /main_dispatch_required/);
  assert.throws(() => context(root, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' }), /main_dispatch_required/);
});

test('release requires successful main push checks and refuses changed main', () => {
  const run = runs => (command, args) => JSON.stringify(args.at(-1).endsWith('/commits/main') ? { sha: selected.commit } : { workflow_runs: runs });
  assert.throws(() => assertVerifiedMain(selected, '.', run([])), /checks_required/);
  assert.throws(() => assertVerifiedMain(selected, '.', () => JSON.stringify({ sha: 'b'.repeat(40) })), /main_changed/);
  assert.throws(() => assertVerifiedMain(selected, '.', run([{ head_sha: selected.commit, head_branch: 'main', event: 'pull_request', conclusion: 'success' }])), /checks_required/);
  assert.equal(assertVerifiedMain(selected, '.', run([{ head_sha: selected.commit, head_branch: 'main', event: 'push', conclusion: 'success' }])).verified, true);
});

test('existing tags and draft releases cannot be overwritten, and API errors fail closed', () => {
  assert.throws(() => assertUnusedVersion(selected, '.', () => JSON.stringify([[{ ref: 'refs/tags/v1.2.3' }]])), /version_exists/);
  assert.throws(() => assertUnusedVersion(selected, '.', () => JSON.stringify([[{ tag_name: 'v1.2.3', draft: true }]])), /version_exists/);
  assert.throws(() => assertUnusedVersion(selected, '.', () => { throw new Error('network unavailable'); }), /network unavailable/);
  assert.doesNotThrow(() => assertUnusedVersion(selected, '.', () => '[[]]'));
});

test('changed SDK or plugin bytes require new component versions across release history', () => {
  const prior = { packages: { 'dispatch-sdk': '1.0.0' }, plugins: [{ pluginId: 'sample', version: '1.0.0', digest: 'a'.repeat(64) }],
    files: [{ path: 'code/node_modules/dispatch-sdk/src/index.js', sha256: 'b'.repeat(64), executable: false }] };
  assert.doesNotThrow(() => assertComponentVersions(prior, [prior]));
  const next = structuredClone(prior);next.plugins[0].digest = 'c'.repeat(64);
  assert.throws(() => assertComponentVersions(next, [prior]), /plugin:sample@1.0.0/);
  next.plugins[0].version = '1.0.1';next.files[0].sha256 = 'd'.repeat(64);
  assert.throws(() => assertComponentVersions(next, [prior]), /package:dispatch-sdk@1.0.0/);
  next.packages['dispatch-sdk'] = '1.0.1';
  assert.doesNotThrow(() => assertComponentVersions(next, [prior]));
});

test('publisher attests before writing and leaves failed uploads as drafts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-publisher-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'publication');fs.mkdirSync(directory);
  const manifest = { product: selected.product, version: selected.version, channel: 'release', source: identity(selected) };
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(manifest));
  const archive = 'dispatch-core-1.2.3.tar.gz';
  fs.writeFileSync(path.join(directory, archive), 'fixture archive');
  fs.writeFileSync(path.join(directory, 'release-notes.md'), 'x'.repeat(30));
  const names = [archive, 'release.json', 'release-notes.md'];
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), names.map(name => `${hash(fs.readFileSync(path.join(directory, name)))}  ${name}\n`).join(''));
  names.push('SHA256SUMS');
  const writes = [];
  let failAttestation = true, corruptUpload = false;
  const run = (command, args) => {
    assert.equal(command, 'gh');
    if (args[0] === 'attestation') {
      assert(args.includes('--deny-self-hosted-runners'));assert(args.includes(selected.commit));
      if (failAttestation) throw new Error('attestation_failed');
      return '';
    }
    if (args[0] === 'api') {
      if (args.includes('POST')) { writes.push('tag');return '{}'; }
      if (args.at(-1).endsWith('/commits/main')) return JSON.stringify({ sha: selected.commit });
      if (args.at(-1).includes('/actions/')) return JSON.stringify({ workflow_runs: [{ head_sha: selected.commit, head_branch: 'main', event: 'push', conclusion: 'success' }] });
      return '[[]]';
    }
    if (args[1] === 'create') { assert(args.includes('--draft'));writes.push('draft'); }
    else if (args[1] === 'download') {
      const target = args[args.indexOf('--dir') + 1];
      for (const name of names) fs.copyFileSync(path.join(directory, name), path.join(target, name));
      if (corruptUpload) fs.appendFileSync(path.join(target, archive), 'tampered');
    } else if (args[1] === 'edit') writes.push('publish');
    else if (args[1] === 'view') return JSON.stringify({ url: 'https://example.com/release', isDraft: false, tagName: 'v1.2.3' });
    else assert.fail(`unexpected command: ${args.join(' ')}`);
    return '';
  };
  assert.throws(() => publish(directory, selected, root, run), /attestation_failed/);
  assert.deepEqual(writes, []);
  failAttestation = false;corruptUpload = true;
  assert.throws(() => publish(directory, selected, root, run), /upload_mismatch/);
  assert.deepEqual(writes, ['tag', 'draft']);
  writes.length = 0;corruptUpload = false;
  assert.equal(publish(directory, selected, root, run).isDraft, false);
  assert.deepEqual(writes, ['tag', 'draft', 'publish']);
});
