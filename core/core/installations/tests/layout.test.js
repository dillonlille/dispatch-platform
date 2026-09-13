'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  INSTALLATION_LAYOUT_TEMPLATE,
  INSTALLATION_LAYOUT_VERSION,
  PRIVATE_DIRECTORY_MODE,
  RELATIVE_DIRECTORIES,
  createInstallationLayoutManager,
} = require('../src');
const {
  resolveManagedInstallationRuntimePaths,
  managedInstallationRuntimeEnvironment,
  managedRuntimeEnvironmentFromProcess,
} = require('../../../shared/paths/runtime-paths');

const EMPTY_FIXTURE_CLEANUP = Object.freeze({
  fixture: true,
  installationState: 'failed',
  retainedData: false,
});

function manifest(id = 'alpha', overrides = {}) {
  const value = {
    manifestVersion: 1,
    revision: 1,
    organization: { id: `org_${id}`, stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: `fixture_${id}`, templateId: INSTALLATION_LAYOUT_TEMPLATE, releaseId: 'dispatch_fixture_1' },
  };
  return {
    ...value,
    ...overrides,
    organization: { ...value.organization, ...(overrides.organization || {}) },
    runtime: { ...value.runtime, ...(overrides.runtime || {}) },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-layout-test-'));
  fs.chmodSync(root, PRIVATE_DIRECTORY_MODE);
  const installationsRoot = path.join(root, 'installations');
  fs.mkdirSync(installationsRoot, { mode: PRIVATE_DIRECTORY_MODE });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, installationsRoot, manager: createInstallationLayoutManager({ installationsRoot }) };
}

function isCode(code) {
  return error => error?.code === code && error.message === code;
}

test('layout derivation is closed, server-bound, and target-safe', t => {
  const { installationsRoot, manager } = fixture(t);
  const selected = manifest();
  const layout = manager.derive(selected, authority(selected));

  assert.equal(INSTALLATION_LAYOUT_VERSION, 1);
  assert.equal(layout.templateId, INSTALLATION_LAYOUT_TEMPLATE);
  assert.equal(layout.projectRoot, path.resolve(__dirname, "../../.."));
  assert.equal(layout.installationRoot, path.join(installationsRoot, selected.runtime.key));
  assert.equal(path.dirname(layout.installationRoot), installationsRoot);
  assert.equal(Object.keys(layout.directories).length, RELATIVE_DIRECTORIES.length);
  assert.equal(Object.isFrozen(layout), true);
  assert.equal(Object.isFrozen(layout.directories), true);
  for (const target of Object.values(layout.directories)) {
    assert.equal(path.relative(layout.installationRoot, target).startsWith('..'), false);
  }

  const wrongAuthority = authority(selected);
  wrongAuthority.runtime.key = 'fixture_bravo';
  assert.throws(() => manager.derive(selected, wrongAuthority), isCode('runtime_identity_mismatch'));
  assert.equal(fs.existsSync(layout.installationRoot), false);

  const unsupported = manifest('unsupported', { runtime: { templateId: 'isolated_dsp_v2' } });
  assert.throws(() => manager.materialize(unsupported, authority(unsupported)), isCode('runtime_boundary_violation'));
  assert.equal(fs.existsSync(path.join(installationsRoot, unsupported.runtime.key)), false);
  assert.throws(() => createInstallationLayoutManager({ installationsRoot, unexpected: true }),
    isCode('runtime_boundary_violation'));
  for (const projectRoot of ['', null, false, 0]) {
    assert.throws(() => createInstallationLayoutManager({ installationsRoot, projectRoot }),
      isCode('runtime_boundary_violation'));
  }
});

test('two fixture layouts materialize privately, remain isolated, and replay idempotently', t => {
  const { installationsRoot, manager } = fixture(t);
  const first = manifest('alpha');
  const second = manifest('bravo');
  const firstLayout = manager.derive(first, authority(first));
  const secondLayout = manager.derive(second, authority(second));

  const firstReceipt = manager.materialize(first, authority(first));
  const secondReceipt = manager.materialize(second, authority(second));
  assert.deepEqual(firstReceipt, {
    layoutVersion: 1,
    status: 'verified',
    directoryCount: RELATIVE_DIRECTORIES.length,
    changed: true,
  });
  assert.equal(secondReceipt.changed, true);
  assert.equal(manager.materialize(first, authority(first)).changed, false);
  assert.equal(manager.inspect(first, authority(first)).status, 'verified');
  assert.equal(Object.isFrozen(firstReceipt), true);
  assert.equal(JSON.stringify(firstReceipt).includes(installationsRoot), false);
  assert.equal(JSON.stringify(firstReceipt).includes(first.runtime.key), false);

  assert.notEqual(firstLayout.installationRoot, secondLayout.installationRoot);
  assert.equal(path.relative(firstLayout.installationRoot, secondLayout.installationRoot).startsWith('..'), true);
  assert.equal(path.relative(secondLayout.installationRoot, firstLayout.installationRoot).startsWith('..'), true);
  const installationsDevice = fs.lstatSync(installationsRoot).dev;
  for (const target of [
    firstLayout.installationRoot,
    secondLayout.installationRoot,
    ...Object.values(firstLayout.directories),
    ...Object.values(secondLayout.directories),
  ]) {
    const info = fs.lstatSync(target);
    assert.equal(info.isDirectory(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.uid, process.geteuid());
    assert.equal(info.dev, installationsDevice);
    assert.equal(info.mode & 0o7777, PRIVATE_DIRECTORY_MODE);
    assert.equal(fs.realpathSync(target), target);
  }
});

test('managed runtime projection supplies isolated component paths without Access Control', t => {
  const { installationsRoot, manager } = fixture(t);
  const selected = manifest('projection');
  manager.materialize(selected, authority(selected));
  const layout = manager.derive(selected, authority(selected));
  const runtimePaths = manager.runtimePaths(selected, authority(selected));
  const environment = manager.runtimeEnvironment(selected, authority(selected));

  assert.equal(runtimePaths.auth.databaseRoot, layout.directories.authDataRoot);
  assert.equal(runtimePaths.auth.secretRoot, layout.directories.authSecretsRoot);
  assert.equal(runtimePaths.collection.databaseRoot, layout.directories.collectionDataRoot);
  assert.equal(runtimePaths.paycom.dataRoot, path.join(layout.directories.providerDataRoot, 'paycom'));
  assert.equal(runtimePaths.cdf.dataRoot, path.join(layout.directories.providerDataRoot, 'cdf'));
  assert.equal(runtimePaths.paycom.stagingRoot, path.join(layout.directories.providerStagingRoot, 'paycom'));
  assert.equal(runtimePaths.cdf.stagingRoot, path.join(layout.directories.providerStagingRoot, 'cdf'));
  assert.equal(Object.hasOwn(runtimePaths, 'accessControl'), false);
  assert.equal(Object.hasOwn(environment, 'DISPATCH_ACCESS_CONTROL_DATABASE_ROOT'), false);
  assert.equal(Object.hasOwn(environment, 'DISPATCH_LOCAL_ROOT'), false);
  assert.equal(environment.DISPATCH_AUTH_SOCKET, runtimePaths.auth.socket);
  assert.equal(Object.isFrozen(runtimePaths), true);
  assert.equal(Object.isFrozen(environment), true);

  const managedProcessEnvironment = { ...environment, DISPATCH_MANAGED_RUNTIME: '1' };
  assert.deepEqual(managedRuntimeEnvironmentFromProcess(managedProcessEnvironment),
    managedInstallationRuntimeEnvironment(layout));
  assert.throws(() => managedRuntimeEnvironmentFromProcess({ ...managedProcessEnvironment, DISPATCH_LOCAL_ROOT: installationsRoot }),
    isCode('unsafe_runtime_config'));
  const missingManagedPath = { ...managedProcessEnvironment };
  delete missingManagedPath.DISPATCH_AUTH_SOCKET;
  assert.throws(() => managedRuntimeEnvironmentFromProcess(missingManagedPath),
    isCode('unsafe_runtime_config'));

  const tampered = {
    ...layout,
    directories: { ...layout.directories, dataRoot: path.join(installationsRoot, 'wrong') },
  };
  assert.throws(() => resolveManagedInstallationRuntimePaths(tampered),
    isCode('unsafe_runtime_config'));

  const projectRoot = path.resolve(__dirname, "../../..");
  const script = `
    const auth = require(${JSON.stringify(path.join(projectRoot, 'runtime/auth-broker/src/paths.js'))}).defaultPaths();
    const collection = require(${JSON.stringify(path.join(projectRoot, 'runtime/collection-manager/src/paths.js'))}).defaultPaths();
    const paycom = require(${JSON.stringify(path.join(projectRoot, 'plugins/paycom/backend/src/paths.js'))});
    const cdf = require(${JSON.stringify(path.join(projectRoot, 'compatibility/cdf/src/paths.js'))});
    process.stdout.write(JSON.stringify({
      auth: { databaseRoot: auth.databaseRoot, secretRoot: auth.secretRoot, stateRoot: auth.stateRoot,
        runtimeRoot: auth.runtimeRoot, socket: auth.socket },
      collection: { databaseRoot: collection.databaseRoot, stateRoot: collection.stateRoot },
      paycom: { dataRoot: paycom.DATA_ROOT, stagingRoot: paycom.STAGING_ROOT, authSocket: paycom.AUTH_SOCKET },
      cdf: { dataRoot: cdf.DATA_ROOT, stagingRoot: cdf.STAGING_ROOT, authSocket: cdf.AUTH_SOCKET },
    }));
  `;
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('DISPATCH_')),
  );
  const child = spawnSync(process.execPath, ['--no-warnings', '-e', script], {
    encoding: 'utf8',
    env: { ...cleanEnvironment, ...environment },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    auth: {
      databaseRoot: runtimePaths.auth.databaseRoot,
      secretRoot: runtimePaths.auth.secretRoot,
      stateRoot: runtimePaths.auth.stateRoot,
      runtimeRoot: runtimePaths.auth.runtimeRoot,
      socket: runtimePaths.auth.socket,
    },
    collection: {
      databaseRoot: runtimePaths.collection.databaseRoot,
      stateRoot: runtimePaths.collection.stateRoot,
    },
    paycom: {
      dataRoot: runtimePaths.paycom.dataRoot,
      stagingRoot: runtimePaths.paycom.stagingRoot,
      authSocket: runtimePaths.paycom.authSocket,
    },
    cdf: {
      dataRoot: runtimePaths.cdf.dataRoot,
      stagingRoot: runtimePaths.cdf.stagingRoot,
      authSocket: runtimePaths.auth.socket,
    },
  });
});

test('unsafe roots and replaced root identities fail before layout mutation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-layout-root-'));
  fs.chmodSync(root, PRIVATE_DIRECTORY_MODE);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unsafeMode = path.join(root, 'unsafe-mode');
  fs.mkdirSync(unsafeMode, { mode: 0o755 });
  assert.throws(() => createInstallationLayoutManager({ installationsRoot: unsafeMode }),
    isCode('runtime_boundary_violation'));

  const specialMode = path.join(root, 'special-mode');
  fs.mkdirSync(specialMode, { mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(specialMode, 0o1700);
  assert.throws(() => createInstallationLayoutManager({ installationsRoot: specialMode }),
    isCode('runtime_boundary_violation'));

  const target = path.join(root, 'target');
  fs.mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(target, alias, 'dir');
  assert.throws(() => createInstallationLayoutManager({ installationsRoot: alias }),
    isCode('runtime_boundary_violation'));

  const source = path.join(root, 'source');
  fs.mkdirSync(source, { mode: PRIVATE_DIRECTORY_MODE });
  const nestedInstallations = path.join(source, 'installations');
  fs.mkdirSync(nestedInstallations, { mode: PRIVATE_DIRECTORY_MODE });
  assert.throws(() => createInstallationLayoutManager({
    projectRoot: source,
    installationsRoot: nestedInstallations,
  }), isCode('runtime_boundary_violation'));

  const enclosingInstallations = path.join(root, 'enclosing');
  fs.mkdirSync(enclosingInstallations, { mode: PRIVATE_DIRECTORY_MODE });
  const nestedSource = path.join(enclosingInstallations, 'source');
  fs.mkdirSync(nestedSource, { mode: PRIVATE_DIRECTORY_MODE });
  assert.throws(() => createInstallationLayoutManager({
    projectRoot: nestedSource,
    installationsRoot: enclosingInstallations,
  }), isCode('runtime_boundary_violation'));

  const pinned = path.join(root, 'pinned');
  fs.mkdirSync(pinned, { mode: PRIVATE_DIRECTORY_MODE });
  const manager = createInstallationLayoutManager({ installationsRoot: pinned });
  fs.renameSync(pinned, `${pinned}-old`);
  fs.mkdirSync(pinned, { mode: PRIVATE_DIRECTORY_MODE });
  const selected = manifest('pinned');
  assert.throws(() => manager.materialize(selected, authority(selected)),
    isCode('runtime_boundary_violation'));
  assert.equal(fs.existsSync(path.join(pinned, selected.runtime.key)), false);
});

test('unsafe partial layouts fail before missing directories are added', t => {
  const { root, installationsRoot, manager } = fixture(t);
  const selected = manifest('partial');
  const layout = manager.derive(selected, authority(selected));
  fs.mkdirSync(layout.installationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  fs.mkdirSync(layout.directories.dataRoot, { mode: 0o755 });

  assert.throws(() => manager.materialize(selected, authority(selected)), isCode('runtime_layout_failed'));
  assert.equal(fs.existsSync(layout.directories.configRoot), false);

  fs.chmodSync(layout.directories.dataRoot, PRIVATE_DIRECTORY_MODE);
  fs.writeFileSync(path.join(layout.directories.dataRoot, 'unexpected'), '', { mode: 0o600 });
  assert.throws(() => manager.materialize(selected, authority(selected)), isCode('runtime_layout_failed'));
  assert.equal(fs.existsSync(layout.directories.configRoot), false);

  fs.rmSync(layout.installationRoot, { recursive: true, force: true });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: PRIVATE_DIRECTORY_MODE });
  fs.symlinkSync(outside, layout.installationRoot, 'dir');
  assert.throws(() => manager.materialize(selected, authority(selected)), isCode('runtime_layout_failed'));
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.lstatSync(layout.installationRoot).isSymbolicLink(), true);
  assert.equal(path.dirname(layout.installationRoot), installationsRoot);
});

test('cleanup is non-recursive, refuses retained content, and removes empty layouts only', t => {
  const { manager } = fixture(t);
  const selected = manifest('cleanup');
  const layout = manager.derive(selected, authority(selected));
  manager.materialize(selected, authority(selected));
  const retained = path.join(layout.directories.logsRoot, 'retained.log');
  fs.writeFileSync(retained, 'fixture', { mode: 0o600 });

  assert.throws(() => manager.removeEmpty(selected, authority(selected), EMPTY_FIXTURE_CLEANUP),
    isCode('runtime_layout_failed'));
  assert.equal(fs.readFileSync(retained, 'utf8'), 'fixture');
  assert.equal(fs.existsSync(layout.directories.configRoot), true);

  fs.unlinkSync(retained);
  assert.throws(() => manager.removeEmpty(selected, authority(selected)),
    isCode('runtime_boundary_violation'));
  assert.throws(() => manager.removeEmpty(selected, authority(selected), {
    fixture: true,
    installationState: 'ready',
    retainedData: false,
  }), isCode('runtime_boundary_violation'));
  assert.equal(fs.existsSync(layout.installationRoot), true);

  assert.deepEqual(manager.removeEmpty(selected, authority(selected), EMPTY_FIXTURE_CLEANUP), {
    layoutVersion: 1,
    status: 'removed',
    directoryCount: 0,
    changed: true,
  });
  assert.equal(fs.existsSync(layout.installationRoot), false);
  assert.equal(manager.removeEmpty(selected, authority(selected), EMPTY_FIXTURE_CLEANUP).changed, false);
});
