'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createInstallationLayoutManager } = require('dispatch-core/core/installations/src/index.js');
const { DispatchClient } = require('../../sdk/src/dispatch-client');
const {
  managedRuntimeConfiguration,
  createManagedRuntimeDispatchClient,
  MANAGED_ENVIRONMENT_KEYS,
} = require('../src');

function manifest() {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_fixture_gateway', stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: 'fixture_gateway', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1' },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

function isBoundary(error) { return ['runtime_boundary_violation', 'runtime_identity_mismatch'].includes(error?.code); }

function fileInventory(root, base = root, found = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) fileInventory(target, base, found);
    else found.push(path.relative(base, target));
  }
  return found.sort();
}

test('managed gateway composition requires the complete explicit runtime projection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgc-'));
  fs.chmodSync(root, 0o700);
  const installationsRoot = path.join(root, 'i');
  fs.mkdirSync(installationsRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const selected = manifest();
  const manager = createInstallationLayoutManager({ installationsRoot });
  manager.materialize(selected, authority(selected));
  const projected = manager.runtimeEnvironment(selected, authority(selected));
  const environment = {
    ...projected,
    DISPATCH_RUNTIME_KEY: selected.runtime.key,
    DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(projected.DISPATCH_RUNTIME_ROOT, 'runtime-gateway.sock'),
  };
  const configuration = managedRuntimeConfiguration(environment);
  assert.equal(configuration.runtimeKey, 'fixture_gateway');
  assert.equal(configuration.gatewaySocket, path.join(configuration.paths.runtimeRoot, 'runtime-gateway.sock'));
  assert.equal(Object.hasOwn(configuration.paths, 'accessControl'), false);
  assert.equal(MANAGED_ENVIRONMENT_KEYS.every(key => environment[key] === projected[key]), true);

  const filesBefore = fileInventory(configuration.paths.installationRoot);
  const client = createManagedRuntimeDispatchClient(configuration);
  assert.equal(client instanceof DispatchClient, true);
  const status = await client.system.status();
  assert.equal(status.ok, true);
  assert.equal(status.status, 'degraded');
  assert.equal(status.data.components.collections.status, 'not_initialized');
  assert.equal(status.data.components.paycom.status, 'not_initialized');
  assert.equal((await client.workforce.day({ date: '2026-09-02', limit: 10, offset: 0 })).status, 'not_initialized');
  assert.deepEqual(fileInventory(configuration.paths.installationRoot), filesBefore);

  const missing = { ...environment };
  delete missing.DISPATCH_COLLECTION_STATE_ROOT;
  assert.throws(() => managedRuntimeConfiguration(missing), isBoundary);
  assert.throws(() => managedRuntimeConfiguration({
    ...environment,
    DISPATCH_RUNTIME_KEY: 'fixture_other',
  }), isBoundary);
  assert.throws(() => managedRuntimeConfiguration({
    ...environment,
    DISPATCH_RUNTIME_GATEWAY_SOCKET: path.join(root, 'other.sock'),
  }), isBoundary);
});
