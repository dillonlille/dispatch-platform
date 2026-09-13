'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PRIVATE_DIRECTORY_MODE,
  RELATIVE_DIRECTORIES,
  createInstallationLayoutManager,
} = require('../src');

function manifest(id) {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: `org_${id}`, stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: `fixture_${id}`, templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1' },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-layout-exercise-'));
fs.chmodSync(fixtureRoot, PRIVATE_DIRECTORY_MODE);
const installationsRoot = path.join(fixtureRoot, 'installations');
fs.mkdirSync(installationsRoot, { mode: PRIVATE_DIRECTORY_MODE });
const cleanupAuthority = { fixture: true, installationState: 'failed', retainedData: false };

try {
  const manager = createInstallationLayoutManager({ installationsRoot });
  const first = manifest('alpha');
  const second = manifest('bravo');
  const firstLayout = manager.derive(first, authority(first));
  const secondLayout = manager.derive(second, authority(second));
  assert.notEqual(firstLayout.installationRoot, secondLayout.installationRoot);
  assert.equal(path.dirname(firstLayout.installationRoot), installationsRoot);
  assert.equal(path.dirname(secondLayout.installationRoot), installationsRoot);

  const createdFirst = manager.materialize(first, authority(first));
  const createdSecond = manager.materialize(second, authority(second));
  const replayed = manager.materialize(first, authority(first));
  assert.deepEqual(createdFirst, { layoutVersion: 1, status: 'verified', directoryCount: RELATIVE_DIRECTORIES.length, changed: true });
  assert.equal(createdSecond.changed, true);
  assert.equal(replayed.changed, false);
  assert.equal(manager.inspect(first, authority(first)).status, 'verified');
  assert.equal(JSON.stringify(createdFirst).includes(fixtureRoot), false);
  const runtimePaths = manager.runtimePaths(first, authority(first));
  const environment = manager.runtimeEnvironment(first, authority(first));
  assert.equal(runtimePaths.auth.databaseRoot, firstLayout.directories.authDataRoot);
  assert.equal(runtimePaths.collection.databaseRoot, firstLayout.directories.collectionDataRoot);
  assert.equal(Object.hasOwn(runtimePaths, 'accessControl'), false);
  assert.equal(Object.hasOwn(environment, 'DISPATCH_ACCESS_CONTROL_DATABASE_ROOT'), false);
  assert.equal(Object.hasOwn(environment, 'DISPATCH_LOCAL_ROOT'), false);

  for (const directory of Object.values(firstLayout.directories)) {
    assert.equal(fs.lstatSync(directory).mode & 0o7777, PRIVATE_DIRECTORY_MODE);
  }

  assert.equal(manager.removeEmpty(first, authority(first), cleanupAuthority).changed, true);
  assert.equal(manager.removeEmpty(first, authority(first), cleanupAuthority).changed, false);
  assert.equal(manager.inspect(second, authority(second)).status, 'verified');
  assert.equal(manager.removeEmpty(second, authority(second), cleanupAuthority).changed, true);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'verified',
    layoutVersion: 1,
    fixtures: 2,
    directoriesPerFixture: RELATIVE_DIRECTORIES.length,
    isolated: true,
    idempotent: true,
    componentPaths: 'verified',
    cleanup: 'empty_only',
  })}\n`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
