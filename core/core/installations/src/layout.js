'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  PROJECT_ROOT,
  MANAGED_INSTALLATION_LAYOUT_VERSION,
  MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
  MANAGED_INSTALLATION_DIRECTORY_FIELDS,
  resolveManagedInstallationRuntimePaths,
  managedInstallationRuntimeEnvironment,
} = require('../../../shared/paths/runtime-paths');
const { serverInstallationManifest } = require('../../../shared/contracts/src');

const INSTALLATION_LAYOUT_VERSION = MANAGED_INSTALLATION_LAYOUT_VERSION;
const INSTALLATION_LAYOUT_TEMPLATE = MANAGED_INSTALLATION_LAYOUT_TEMPLATE;
const PRIVATE_DIRECTORY_MODE = 0o700;
const DIRECTORY_FIELDS = MANAGED_INSTALLATION_DIRECTORY_FIELDS;
const RELATIVE_DIRECTORIES = Object.freeze(Object.values(DIRECTORY_FIELDS));

const CHILDREN = (() => {
  const selected = new Map();
  for (const relative of RELATIVE_DIRECTORIES) {
    const parent = path.dirname(relative) === '.' ? '' : path.dirname(relative);
    if (!selected.has(parent)) selected.set(parent, new Set());
    selected.get(parent).add(path.basename(relative));
  }
  return selected;
})();

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, allowed, required, code) {
  if (!plain(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\0\r\n]/.test(value)) fail('runtime_boundary_violation');
  return value;
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function lstatMaybe(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('runtime_layout_failed');
  }
}

function effectiveUid() {
  if (typeof process.geteuid !== 'function') fail('runtime_boundary_violation');
  return process.geteuid();
}

function privateDirectoryIdentity(target, code = 'runtime_layout_failed', expectedDevice = null) {
  const selected = absolute(target);
  const info = lstatMaybe(selected);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== effectiveUid()
      || (info.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
      || (expectedDevice !== null && info.dev !== expectedDevice)) fail(code);
  let canonical;
  try { canonical = fs.realpathSync(selected); } catch { fail(code); }
  if (canonical !== selected) fail(code);
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function canonicalProjectRoot(projectRoot) {
  const selected = absolute(projectRoot);
  const info = lstatMaybe(selected);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail('runtime_boundary_violation');
  let canonical;
  try { canonical = fs.realpathSync(selected); } catch { fail('runtime_boundary_violation'); }
  if (canonical !== selected) fail('runtime_boundary_violation');
  return selected;
}

function configuredRoot(options) {
  exact(options, ['installationsRoot', 'projectRoot'], ['installationsRoot'], 'runtime_boundary_violation');
  const installationsRoot = absolute(options.installationsRoot);
  const projectRoot = canonicalProjectRoot(
    options.projectRoot === undefined ? PROJECT_ROOT : options.projectRoot,
  );
  if (installationsRoot === path.parse(installationsRoot).root) fail('runtime_boundary_violation');
  privateDirectoryIdentity(installationsRoot, 'runtime_boundary_violation');
  if (contains(projectRoot, installationsRoot) || contains(installationsRoot, projectRoot)) {
    fail('runtime_boundary_violation');
  }
  return Object.freeze({ installationsRoot, projectRoot });
}

function resolvedLayout(config, manifestValue, authorityValue) {
  const manifest = serverInstallationManifest(manifestValue, authorityValue);
  if (manifest.runtime.templateId !== INSTALLATION_LAYOUT_TEMPLATE) fail('runtime_boundary_violation');
  const installationRoot = path.join(config.installationsRoot, manifest.runtime.key);
  if (path.dirname(installationRoot) !== config.installationsRoot) fail('runtime_boundary_violation');
  const directories = Object.fromEntries(Object.entries(DIRECTORY_FIELDS)
    .map(([field, relative]) => [field, path.join(installationRoot, relative)]));
  return Object.freeze({
    layoutVersion: INSTALLATION_LAYOUT_VERSION,
    templateId: INSTALLATION_LAYOUT_TEMPLATE,
    runtimeKey: manifest.runtime.key,
    projectRoot: config.projectRoot,
    installationRoot,
    directories: Object.freeze(directories),
  });
}

function directoryFor(root, relative) {
  return relative ? path.join(root, relative) : root;
}

function validatePartialLayout(layout, expectedDevice = null) {
  const installationIdentity = privateDirectoryIdentity(
    layout.installationRoot,
    'runtime_layout_failed',
    expectedDevice,
  );
  for (const relative of RELATIVE_DIRECTORIES) {
    const target = directoryFor(layout.installationRoot, relative);
    if (lstatMaybe(target)) {
      privateDirectoryIdentity(target, 'runtime_layout_failed', installationIdentity.dev);
    }
  }
  for (const [relative, expected] of CHILDREN) {
    const parent = directoryFor(layout.installationRoot, relative);
    if (!lstatMaybe(parent)) continue;
    privateDirectoryIdentity(parent);
    let entries;
    try { entries = fs.readdirSync(parent); } catch { fail('runtime_layout_failed'); }
    if (entries.some(name => !expected.has(name))) fail('runtime_layout_failed');
  }
}

function validateCompleteLayout(layout, expectedDevice = null) {
  validatePartialLayout(layout, expectedDevice);
  const installationIdentity = privateDirectoryIdentity(
    layout.installationRoot,
    'runtime_layout_failed',
    expectedDevice,
  );
  for (const relative of RELATIVE_DIRECTORIES) {
    privateDirectoryIdentity(
      directoryFor(layout.installationRoot, relative),
      'runtime_layout_failed',
      installationIdentity.dev,
    );
  }
}

function directMutation(operation) {
  return operation();
}

function ensurePrivateDirectory(target, parent, mutate) {
  const parentBefore = privateDirectoryIdentity(parent);
  let changed = false;
  if (!lstatMaybe(target)) {
    try {
      changed = mutate(() => {
        if (lstatMaybe(target)) return false;
        fs.mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
        return true;
      }) === true;
    } catch (error) {
      if (error?.code === 'installation_operation_in_progress') throw error;
      if (error?.code !== 'EEXIST') fail('runtime_layout_failed');
    }
  }
  privateDirectoryIdentity(target, 'runtime_layout_failed', parentBefore.dev);
  const parentAfter = privateDirectoryIdentity(parent);
  if (!sameIdentity(parentBefore, parentAfter)) fail('runtime_layout_failed');
  return changed;
}

function summary(status, directoryCount, changed) {
  return Object.freeze({
    layoutVersion: INSTALLATION_LAYOUT_VERSION,
    status,
    directoryCount,
    changed,
  });
}

function assertEmptyCleanupAuthority(value) {
  exact(
    value,
    ['fixture', 'installationState', 'retainedData'],
    ['fixture', 'installationState', 'retainedData'],
    'runtime_boundary_violation',
  );
  if (value.fixture !== true || value.installationState !== 'failed' || value.retainedData !== false) {
    fail('runtime_boundary_violation');
  }
}

function createInstallationLayoutManager(options) {
  const config = configuredRoot(options);
  const rootIdentity = privateDirectoryIdentity(config.installationsRoot, 'runtime_boundary_violation');

  function assertRoot() {
    const current = privateDirectoryIdentity(config.installationsRoot, 'runtime_boundary_violation');
    if (!sameIdentity(rootIdentity, current)) fail('runtime_boundary_violation');
  }

  function derive(manifestValue, authorityValue) {
    assertRoot();
    return resolvedLayout(config, manifestValue, authorityValue);
  }

  function runtimePaths(manifestValue, authorityValue) {
    return resolveManagedInstallationRuntimePaths(derive(manifestValue, authorityValue));
  }

  function runtimeEnvironment(manifestValue, authorityValue) {
    return managedInstallationRuntimeEnvironment(derive(manifestValue, authorityValue));
  }

  function inspect(manifestValue, authorityValue) {
    const layout = derive(manifestValue, authorityValue);
    validateCompleteLayout(layout, rootIdentity.dev);
    assertRoot();
    return summary('verified', RELATIVE_DIRECTORIES.length, false);
  }

  function materialize(manifestValue, authorityValue, mutationCapability = directMutation) {
    if (typeof mutationCapability !== 'function') fail('runtime_boundary_violation');
    const layout = derive(manifestValue, authorityValue);
    const existing = lstatMaybe(layout.installationRoot);
    if (existing) validatePartialLayout(layout, rootIdentity.dev);
    assertRoot();

    let changed = false;
    if (!existing) {
      changed = ensurePrivateDirectory(
        layout.installationRoot,
        config.installationsRoot,
        mutationCapability,
      ) || changed;
    }
    for (const relative of RELATIVE_DIRECTORIES) {
      assertRoot();
      const target = directoryFor(layout.installationRoot, relative);
      const parent = path.dirname(target);
      changed = ensurePrivateDirectory(target, parent, mutationCapability) || changed;
    }
    validateCompleteLayout(layout, rootIdentity.dev);
    assertRoot();
    return summary('verified', RELATIVE_DIRECTORIES.length, changed);
  }

  function removeEmpty(manifestValue, authorityValue, cleanupAuthority) {
    assertEmptyCleanupAuthority(cleanupAuthority);
    const layout = derive(manifestValue, authorityValue);
    if (!lstatMaybe(layout.installationRoot)) return summary('removed', 0, false);
    validatePartialLayout(layout, rootIdentity.dev);

    for (const relative of RELATIVE_DIRECTORIES) {
      const target = directoryFor(layout.installationRoot, relative);
      if (!lstatMaybe(target) || CHILDREN.has(relative)) continue;
      let entries;
      try { entries = fs.readdirSync(target); } catch { fail('runtime_layout_failed'); }
      if (entries.length !== 0) fail('runtime_layout_failed');
    }

    const installationIdentity = privateDirectoryIdentity(
      layout.installationRoot,
      'runtime_layout_failed',
      rootIdentity.dev,
    );
    const removalOrder = [...RELATIVE_DIRECTORIES]
      .sort((left, right) => right.split('/').length - left.split('/').length);
    for (const relative of removalOrder) {
      assertRoot();
      const target = directoryFor(layout.installationRoot, relative);
      if (!lstatMaybe(target)) continue;
      privateDirectoryIdentity(target, 'runtime_layout_failed', installationIdentity.dev);
      try { fs.rmdirSync(target); } catch { fail('runtime_layout_failed'); }
    }
    assertRoot();
    privateDirectoryIdentity(layout.installationRoot, 'runtime_layout_failed', rootIdentity.dev);
    try { fs.rmdirSync(layout.installationRoot); } catch { fail('runtime_layout_failed'); }
    assertRoot();
    return summary('removed', 0, true);
  }

  return Object.freeze({ derive, runtimePaths, runtimeEnvironment, inspect, materialize, removeEmpty });
}

module.exports = {
  INSTALLATION_LAYOUT_VERSION,
  INSTALLATION_LAYOUT_TEMPLATE,
  PRIVATE_DIRECTORY_MODE,
  RELATIVE_DIRECTORIES,
  createInstallationLayoutManager,
};
