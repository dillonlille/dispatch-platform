'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('bridge release artifact is a deterministic read-only allowlist with a content manifest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-bridge-release-'));
  const target = path.join(root, 'bridge-artifact');
  t.after(() => {
    if (fs.existsSync(target)) {
      const makeWritable = directory => {
        fs.chmodSync(directory, 0o700);
        for (const name of fs.readdirSync(directory)) {
          const child = path.join(directory, name);
          if (fs.lstatSync(child).isDirectory()) makeWritable(child);
        }
      };
      makeWritable(target);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = spawnSync('/usr/bin/node', [
    '--no-warnings', path.resolve(__dirname, "../src/create-bridge-artifact.js"), target,
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  const loaded = spawnSync(process.execPath, ['--no-warnings', '-e',
    `require(${JSON.stringify(path.join(target, 'core/agent-bridge/src/bridge.js'))})`], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);

  const manifestFile = path.join(target, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(receipt.manifestSha256,
    crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex'));
  assert.equal(receipt.files, manifest.files.length);
  assert.equal(fs.lstatSync(target).mode & 0o7777, 0o555);
  for (const entry of manifest.files) {
    const file = path.join(target, entry.path);
    assert.equal(fs.lstatSync(file).mode & 0o7777, 0o444);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), entry.sha256);
  }
});

test('privileged host-helper artifact contains only its explicit immutable dependency closure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-host-helper-release-'));
  const target = path.join(root, 'host-helper-artifact');
  t.after(() => {
    if (fs.existsSync(target)) {
      const makeWritable = directory => {
        fs.chmodSync(directory, 0o700);
        for (const name of fs.readdirSync(directory)) {
          const child = path.join(directory, name);
          if (fs.lstatSync(child).isDirectory()) makeWritable(child);
        }
      };
      makeWritable(target);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = spawnSync('/usr/bin/node', [
    '--no-warnings', path.resolve(__dirname, "../src/create-host-helper-artifact.js"), target,
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  const loaded = spawnSync(process.execPath, ['--no-warnings', '-e',
    `require(${JSON.stringify(path.join(target, 'core/installations/src/oci-host-helper.js'))}); require(${JSON.stringify(path.join(target, 'core/installations/src/oci-host-issuer.js'))});`], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  assert.equal(receipt.files, manifest.files.length);
  assert.equal(manifest.files.some(file => file.path.includes('access-control')), false);
  assert.equal(manifest.files.some(file => file.path.includes('interfaces/')), false);
  for (const entry of manifest.files) {
    assert.equal((fs.lstatSync(path.join(target, entry.path)).mode & 0o7777).toString(8), entry.mode);
  }
});
