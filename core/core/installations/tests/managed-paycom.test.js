'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { fixture } = require('dispatch-dsp/runtime/collection-manager/tests/helpers.js');
const {
  managedPaycomDefinition,
  managedPaycomFirstPublicationRequest,
} = require('../../../compatibility/provisioner/src/managed-paycom.js');

function manifest(timezone = 'America/Chicago') {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_activation_fixture', stationCode: 'TST1', timezone },
    runtime: { key: 'fixture_activation', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1' },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

test('managed Paycom configuration is server-owned, tenant-timezone-bound, and manager-valid', () => {
  const selected = manifest();
  const definition = managedPaycomDefinition(selected, authority(selected));
  assert.equal(definition.profileId, 'paycom-main');
  assert.equal(definition.sourceId, 'paycom-main');
  assert.equal(definition.syncId, 'paycom-main-workforce');
  assert.match(definition.digest, /^[a-f0-9]{64}$/);
  assert.equal(definition.specification.sources[0].config.timezone, 'America/Chicago');
  assert.equal(definition.specification.sources[0].authProfile, 'paycom-main');
  assert.equal(definition.specification.syncs[0].desiredState, 'stopped');
  assert.equal(Object.isFrozen(definition.specification), true);

  const context = fixture();
  const store = new CollectionStore(context.paths);
  require('dispatch-runtime-kit/collection-manager/src/plugin-state').applyState(store, { command: 'apply', pluginId: 'paycom', version: '0.18.7', state: 'enabled', revision: 1 });
  try {
    assert.deepEqual(store.applySpec(definition.specification), {
      collectors: 1,
      sources: 1,
      plans: 15,
      syncs: 1,
    });
    assert.equal(store.source('paycom-main').authProfile, 'paycom-main');
    assert.equal(store.sourceRuntime('paycom-main').config.timezone, 'America/Chicago');
    assert.equal(store.sync('paycom-main-workforce').desiredState, 'stopped');
  } finally {
    store.close();
    fs.rmSync(context.root, { recursive: true, force: true });
  }
});

test('managed Paycom configuration rejects authority drift and exposes one fixed activation request', () => {
  const selected = manifest();
  const mismatched = authority(selected);
  mismatched.organization.timezone = 'UTC';
  assert.throws(() => managedPaycomDefinition(selected, mismatched), /runtime_boundary_violation/);
  assert.throws(() => managedPaycomDefinition(selected, authority(selected), { projectRoot: '' }), /runtime_boundary_violation/);
  assert.deepEqual(managedPaycomFirstPublicationRequest(), {
    source: 'paycom-main',
    scope: 'full',
    selector: { kind: 'current' },
    mode: 'refresh',
  });
});

test('managed Paycom source validation accepts the reviewed tree and rejects changed collector bytes', t => {
  const { verifyManagedPaycomSource } = require('dispatch-dsp/plugins/paycom/backend/runtime/definition.js');
  const root = path.resolve(__dirname, '../../..');
  assert.equal(verifyManagedPaycomSource(root), root);
  const read = fs.readFileSync;
  const changed = path.join(root, 'plugins/paycom/backend/bin/dispatch-paycom-collector');
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const value = read(file, ...args);
    return file === changed ? Buffer.concat([Buffer.from(value), Buffer.from('\n// changed collector\n')]) : value;
  });
  assert.throws(() => verifyManagedPaycomSource(root), error => error.code === 'runtime_boundary_violation');
});
