'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  OCI_HOST_REGISTRY_SCHEMA_VERSION,
  createOciHostAccountRegistry,
} = require('../src/oci-host-account-registry');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-oci-host-registry-'));
  fs.chmodSync(root, 0o700);
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  const subuidFile = path.join(root, 'subuid');
  const subgidFile = path.join(root, 'subgid');
  fs.writeFileSync(subuidFile, 'existing:1000000:65536\n', { mode: 0o600 });
  fs.writeFileSync(subgidFile, 'existing:1000000:65536\n', { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateRoot, subuidFile, subgidFile };
}

function manager(paths, clock = () => 1_000) {
  return createOciHostAccountRegistry({
    stateRoot: paths.stateRoot,
    subuidFile: paths.subuidFile,
    subgidFile: paths.subgidFile,
    uidMinimum: 20_000,
    uidMaximum: 20_010,
    identityAvailable: value => value !== 20_001,
    clock,
  });
}

test('OCI host account registry durably reserves distinct identities and never reuses retired allocations', t => {
  const paths = fixture(t);
  let now = 1_000;
  let selected = manager(paths, () => ++now);
  const alpha = selected.reserve('runtime_oci_alpha');
  const beta = selected.reserve('runtime_oci_beta');
  assert.deepEqual(selected.reserve('runtime_oci_alpha'), alpha);
  assert.equal(alpha.uid, 20_000);
  assert.equal(beta.uid, 20_002);
  assert.equal(alpha.subuidStart, 1_114_112);
  assert.equal(beta.subuidStart, alpha.subuidStart + 65_536);
  assert.equal(alpha.name.startsWith('dsp-'), true);
  assert.equal(selected.activate(alpha.runtimeKey).status, 'active');
  assert.equal(selected.activate(alpha.runtimeKey).status, 'active');
  assert.equal(selected.retire(alpha.runtimeKey).status, 'retired');
  selected.close();

  selected = manager(paths, () => ++now);
  assert.equal(selected.inspect(alpha.runtimeKey).status, 'retired');
  assert.deepEqual(selected.inspect(beta.runtimeKey), beta);
  assert.equal(selected.reserve('runtime_oci_gamma').uid, 20_003);
  assert.equal(selected.reserve('runtime_oci_gamma').subuidStart, beta.subuidStart + 65_536);
  assert.equal(selected.inspect('runtime_unknown'), null);
  assert.equal(OCI_HOST_REGISTRY_SCHEMA_VERSION, 1);
  selected.close();
});

test('OCI host account registry fails closed on unsafe roots and identity exhaustion', t => {
  const paths = fixture(t);
  fs.chmodSync(paths.stateRoot, 0o755);
  assert.throws(() => manager(paths), error => error.code === 'runtime_boundary_violation');
  fs.chmodSync(paths.stateRoot, 0o700);
  const selected = createOciHostAccountRegistry({
    stateRoot: paths.stateRoot,
    subuidFile: paths.subuidFile,
    subgidFile: paths.subgidFile,
    uidMinimum: 20_000,
    uidMaximum: 20_000,
    identityAvailable: () => false,
  });
  assert.throws(() => selected.reserve('runtime_exhausted'),
    error => error.code === 'service_installation_failed');
  assert.throws(() => selected.reserve('../unsafe'), error => error.code === 'runtime_boundary_violation');
  selected.close();
});
