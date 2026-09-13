'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { directory, dspPath, platformPaths, validateDspId } = require('../../shared/paths/platform-paths');
const { MANAGED_INSTALLATION_DIRECTORY_FIELDS } = require('../../shared/paths/runtime-paths');
const { privateJson } = require('../../core/installations/src/release-delivery-files');
const { syncDirectory } = require('../controller/operations');
const { assertVolumeMounted } = require('./volume-state');

// Persisted by the initial directory layout. Runtime selection is separate;
// changing this marker requires a versioned metadata migration.
const BACKEND = 'directory_sandbox_v1';
const STORAGE_DIRECTORIES = Object.freeze(['config', 'data', 'secrets', 'state', 'run', 'staging', 'logs', 'backups', 'browser', 'plugins']);

function fail() { throw new Error('directory_dsp_invalid'); }

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function initializeDirectories(root) {
  const relatives = [...Object.values(MANAGED_INSTALLATION_DIRECTORY_FIELDS), 'browser', 'plugins',
    ...STORAGE_DIRECTORIES.map(name => `.storage-view/${name}`)];
  for (const relative of relatives) {
    let current = root;
    for (const name of relative.split('/')) {
      current = path.join(current, name);
      if (!exists(current)) { fs.mkdirSync(current, { mode: 0o700 }); syncDirectory(path.dirname(current)); }
      directory(current);
      if ((fs.statSync(current).mode & 0o7777) !== 0o700) fail();
    }
  }
  const marker = path.join(root, 'config/storage-layout.json');
  if (!exists(marker)) require('../../core/installations/src/release-delivery-files').atomic(marker, { version: 2 });
}

// This local backend deliberately has no account management or privileged host
// executor. Production provisioning remains gated until the runtime, browser,
// bridge, backup and lifecycle integrations have all passed their acceptance tests.
function createDsp(paths, { id = `dsp_${crypto.randomBytes(16).toString('hex')}` } = {}) {
  paths = platformPaths(paths.platformRoot);
  validateDspId(id);
  require('./deletion-state').assertRetained(paths, id);
  const root = dspPath(paths, id);
  fs.mkdirSync(root, { mode: 0o700 }); // Exclusive reservation; never adopt an existing directory.
  const marker = path.join(root, '.provisioning');
  fs.writeFileSync(marker, '1\n', { mode: 0o600, flag: 'wx' });
  // Interrupted initialization is retained for inspection, never recursively
  // deleted or silently accepted as a ready DSP.
  initializeDirectories(root);
  fs.writeFileSync(path.join(root, 'config/dsp.json'), JSON.stringify({ version: 1, id, backend: BACKEND }) + '\n',
    { mode: 0o600, flag: 'wx' });
  fs.unlinkSync(marker);
  return inspectDsp(paths, id);
}

function inspectDsp(paths, id, { allowUnmounted = false } = {}) {
  paths = platformPaths(paths.platformRoot);
  const root = directory(dspPath(paths, validateDspId(id)));
  if (!allowUnmounted) assertVolumeMounted(root);
  if (fs.statSync(root).mode & 0o077 || exists(path.join(root, '.provisioning'))) fail();
  for (const relative of [...Object.values(MANAGED_INSTALLATION_DIRECTORY_FIELDS), 'browser']) {
    const selected = directory(path.join(root, relative));
    if (fs.statSync(selected).mode & 0o077) fail();
  }
  const file = path.join(root, 'config/dsp.json');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let value;
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1
        || (info.mode & 0o777) !== 0o600 || info.size > 1024) fail();
    value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const legacy = value.version === 1 && value.backend === BACKEND
      && Object.keys(value).sort().join(',') === 'backend,id,version';
    const managed = value.version === 2 && value.backend === 'directory_service_v1'
      && Object.keys(value).sort().join(',') === 'backend,creationId,id,version'
      && /^create_[a-f0-9]{32}$/.test(value.creationId);
    if (value.id !== id || !(legacy || managed)) fail();
  } finally { fs.closeSync(fd); }
  return Object.freeze({ id, root, backend: value.backend, ...(value.creationId ? { creationId: value.creationId } : {}) });
}

// Only the private operation journal supplies creationId. Retries may resume
// their own reservation, never adopt another DSP or an unmanaged data directory.
function ensureDsp(paths, id, creationId) {
  paths = platformPaths(paths.platformRoot);
  const root = dspPath(paths, id);
  require('./deletion-state').assertRetained(paths, id);
  if (!/^create_[a-f0-9]{32}$/.test(creationId)) fail();
  if (!exists(root)) { fs.mkdirSync(root, { mode: 0o700 }); syncDirectory(paths.dsps); }
  directory(root);
  if ((fs.statSync(root).mode & 0o7777) !== 0o700) fail();
  const marker = path.join(root, '.provisioning');
  const metadata = path.join(root, 'config/dsp.json');
  if (!exists(marker) && exists(metadata)) {
    const dsp = inspectDsp(paths, id, { allowUnmounted: true });
    if (dsp.creationId !== creationId) fail();
    return dsp;
  }
  if (!exists(marker)) {
    if (fs.readdirSync(root).length !== 0) fail();
    fs.writeFileSync(marker, JSON.stringify({ version: 1, id, creationId }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const reservation = privateJson(marker, process.geteuid());
  if (JSON.stringify(reservation) !== JSON.stringify({ version: 1, id, creationId })) fail();
  const reservationFd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(reservationFd); } finally { fs.closeSync(reservationFd); }
  syncDirectory(root);
  initializeDirectories(root);
  const expected = { version: 2, id, backend: 'directory_service_v1', creationId };
  if (exists(metadata)) {
    if (JSON.stringify(privateJson(metadata, process.geteuid())) !== JSON.stringify(expected)) fail();
  } else fs.writeFileSync(metadata, JSON.stringify(expected) + '\n', { flag: 'wx', mode: 0o600 });
  // Publish only after all metadata and directories are durable.
  for (const file of [marker, metadata]) {
    const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  syncDirectory(path.dirname(metadata));
  fs.unlinkSync(marker);
  const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return inspectDsp(paths, id);
}

function inspectStorageView(dsp) {
  const view = directory(path.join(dsp.root, '.storage-view'));
  if (fs.statSync(view).mode & 0o077) fail();
  for (const name of STORAGE_DIRECTORIES) {
    const selected = directory(path.join(view, name));
    if (fs.statSync(selected).mode & 0o077) fail();
  }
  return view;
}

module.exports = { BACKEND, STORAGE_DIRECTORIES, createDsp, ensureDsp, inspectDsp, inspectStorageView };
