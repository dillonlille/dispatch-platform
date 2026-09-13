'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parse, preflight } = require('../src/install-command');
const config = { uid: 1001, gid: 1001, localRoot: '/srv/dispatch/local', unitRoot: '/srv/dispatch/units' };
test('installation commands require an exact version and commit and separate setup inputs', () => {
  const args = ['prepare', '--version', '1.2.3', '--commit', 'a'.repeat(40)];
  assert.equal(parse(args).version, '1.2.3');
  for (const invalid of [['update'], [...args, '--version', '1.2.4'], [...args, '--force', 'true'], [...args, '--config', '/tmp/config'], ['setup', '--config', '../config', '--core', '/tmp/core']]) assert.throws(() => parse(invalid));
  assert.equal(parse(['setup', '--config', '/root/config.json', '--core', '/root/core.json']).action, 'setup');
});
test('preflight reports every missing prerequisite before any installation action', () => {
  const result = preflight(config, { exists: () => false, run: () => ({ status: 2, stdout: '' }), platform: 'linux', arch: 'x64' });
  assert.equal(result.ok, false); assert.ok(result.missing.includes('configured_service_account_required'));
  assert.ok(result.missing.includes('missing:config/provisioning.env'));
  assert.ok(result.missing.includes('release_delivery_setup_required'));
});
test('dependency pins reject an unexpected runtime version before packaging', () => {
  const { verify } = require('../src/release-dependencies');
  const pins = require('../runtime-dependencies.json');
  assert.deepEqual(verify({ run: file => ({ status: 0, stdout: file.endsWith('chrome') ? `Google Chrome for Testing ${pins.chrome}` : `v${pins.node}` }) }), { node: pins.node, chrome: pins.chrome });
  assert.throws(() => verify({ run: () => ({ status: 0, stdout: 'v0.0.0' }) }), /release_dependency_version_mismatch/);
});
