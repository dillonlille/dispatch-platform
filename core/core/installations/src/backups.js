'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { INSTALLATION_IDENTIFIER_RE } = require('../../../shared/contracts/src/installation');

const BACKUP_FORMAT_VERSION = 1;
const BACKUP_ROOTS = Object.freeze(['data', 'state']);
const MAX_BACKUP_FILES = 100_000;
const MAX_BACKUP_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 2 * 1024 * 1024 * 1024;

function fail(code = 'backup_failed') { throw Object.assign(new Error(code), { code }); }
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, allowed, required, code = 'runtime_boundary_violation') {
  if (!plain(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}
function identifier(value) {
  if (typeof value !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value)) fail('runtime_boundary_violation');
  return value;
}
function lstatMaybe(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function canonicalDirectory(target, expectedDevice = null, code = 'backup_failed') {
  const info = lstatMaybe(target);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== 0o700 || expectedDevice !== null && info.dev !== expectedDevice) fail(code);
  let canonical;
  try { canonical = fs.realpathSync(target); } catch { fail(code); }
  if (canonical !== target) fail(code);
  return info;
}
function safeFile(target, expectedDevice, code = 'backup_failed') {
  const info = lstatMaybe(target);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || info.nlink !== 1 || info.dev !== expectedDevice || (info.mode & 0o077) !== 0
      || info.size > MAX_BACKUP_FILE_BYTES) fail(code);
  return info;
}
function digestBuffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readFileDigest(target, device, code = 'backup_failed') {
  const before = safeFile(target, device, code);
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(handle);
    if (!opened.isFile() || opened.uid !== process.geteuid() || opened.nlink !== 1
        || opened.dev !== device || opened.ino !== before.ino || (opened.mode & 0o077) !== 0
        || opened.size > MAX_BACKUP_FILE_BYTES) fail(code);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
    const after = fs.fstatSync(handle);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || size !== opened.size) fail(code);
    return { size, sha256: hash.digest('hex') };
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
function syncDirectory(directory) {
  let handle;
  try { handle = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(handle); }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}
function writePrivate(target, content, parentDevice) {
  const parent = path.dirname(target);
  canonicalDirectory(parent, parentDevice);
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
  } finally { if (handle !== undefined) fs.closeSync(handle); }
  safeFile(target, parentDevice);
  syncDirectory(parent);
}
function makePrivate(target, parentDevice) {
  const parent = path.dirname(target);
  canonicalDirectory(parent, parentDevice);
  fs.mkdirSync(target, { mode: 0o700 });
  canonicalDirectory(target, parentDevice);
  syncDirectory(parent);
}
function scanTree(root, label, device) {
  canonicalDirectory(root, device);
  const entries = [];
  let fileCount = 0;
  let totalBytes = 0;
  function visit(directory, relative) {
    canonicalDirectory(directory, device);
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) fail();
      const target = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const info = lstatMaybe(target);
      if (!info || info.isSymbolicLink() || info.uid !== process.geteuid() || info.dev !== device) fail();
      if (info.isDirectory()) {
        if ((info.mode & 0o7777) !== 0o700) fail();
        entries.push({ path: `${label}/${childRelative}`, type: 'directory' });
        visit(target, childRelative);
      } else if (info.isFile()) {
        const digested = readFileDigest(target, device);
        fileCount += 1;
        totalBytes += digested.size;
        if (fileCount > MAX_BACKUP_FILES || totalBytes > MAX_BACKUP_BYTES) fail();
        entries.push({
          path: `${label}/${childRelative}`,
          type: 'file',
          size: digested.size,
          sha256: digested.sha256,
        });
      } else fail();
    }
  }
  visit(root, '');
  return { entries, fileCount, totalBytes };
}
function scanRoots(roots, labels = BACKUP_ROOTS) {
  const device = canonicalDirectory(roots[0]).dev;
  const result = { entries: [], fileCount: 0, totalBytes: 0 };
  for (const [label, root] of labels.map(label => [label, rootsByLabel(roots, labels)[label]])) {
    const scanned = scanTree(root, label, device);
    result.entries.push(...scanned.entries);
    result.fileCount += scanned.fileCount;
    result.totalBytes += scanned.totalBytes;
  }
  result.entries.sort((left, right) => left.path.localeCompare(right.path));
  result.treeDigest = digestBuffer(JSON.stringify(result.entries));
  return result;
}
function rootsByLabel(roots, labels = BACKUP_ROOTS) {
  return Object.freeze(Object.fromEntries(labels.map((label, index) => [label, roots[index]])));
}
function copyTree(source, destination, device) {
  makePrivate(destination, device);
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const info = lstatMaybe(from);
    if (!info || info.isSymbolicLink() || info.uid !== process.geteuid() || info.dev !== device) fail();
    if (info.isDirectory()) {
      canonicalDirectory(from, device);
      copyTree(from, to, device);
    } else if (info.isFile()) {
      const parent = path.dirname(to);
      canonicalDirectory(parent, device);
      const before = safeFile(from, device);
      let input;
      let output;
      try {
        input = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(input);
        if (opened.dev !== device || opened.ino !== before.ino || opened.uid !== process.geteuid()
            || opened.nlink !== 1 || !opened.isFile() || (opened.mode & 0o077) !== 0) fail();
        output = fs.openSync(to, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
          | (fs.constants.O_NOFOLLOW || 0), 0o600);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let copied = 0;
        while (true) {
          const read = fs.readSync(input, buffer, 0, buffer.length, null);
          if (read === 0) break;
          let written = 0;
          while (written < read) written += fs.writeSync(output, buffer, written, read - written);
          copied += read;
        }
        const after = fs.fstatSync(input);
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || copied !== opened.size) fail();
        fs.fsyncSync(output);
      } finally {
        if (output !== undefined) fs.closeSync(output);
        if (input !== undefined) fs.closeSync(input);
      }
      safeFile(to, device);
      syncDirectory(parent);
    } else fail();
  }
}
function removeTree(target, device, code = 'backup_failed') {
  const info = lstatMaybe(target);
  if (!info) return;
  if (info.isSymbolicLink() || info.uid !== process.geteuid() || info.dev !== device) fail(code);
  if (info.isDirectory()) {
    canonicalDirectory(target, device, code);
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name), device, code);
    syncDirectory(target);
    fs.rmdirSync(target);
    syncDirectory(path.dirname(target));
  } else if (info.isFile()) {
    safeFile(target, device, code);
    fs.unlinkSync(target);
    syncDirectory(path.dirname(target));
  } else fail(code);
}
function validateSpec(spec, { source = false } = {}) {
  exact(spec, source
    ? ['id', 'purpose', 'manifestRevision', 'releaseId', 'status', 'treeDigest', 'fileCount', 'totalBytes']
    : ['id', 'purpose', 'manifestRevision', 'releaseId', 'status'],
  source
    ? ['id', 'purpose', 'manifestRevision', 'releaseId', 'status', 'treeDigest', 'fileCount', 'totalBytes']
    : ['id', 'purpose', 'manifestRevision', 'releaseId', 'status']);
  identifier(spec.id);
  if (!['manual', 'upgrade', 'restore_safety', 'decommission'].includes(spec.purpose)
      || !Number.isSafeInteger(spec.manifestRevision) || spec.manifestRevision < 1
      || typeof spec.releaseId !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(spec.releaseId)
      || !['reserved', 'available'].includes(spec.status)) fail('runtime_boundary_violation');
  if (source && (spec.status !== 'available' || !/^[a-f0-9]{64}$/.test(spec.treeDigest)
      || !Number.isSafeInteger(spec.fileCount) || spec.fileCount < 0
      || !Number.isSafeInteger(spec.totalBytes) || spec.totalBytes < 0)) fail('restore_failed');
  return spec;
}

function createInstallationBackupManager(options) {
  exact(options, ['layout', 'full'], ['layout']);
  const labels = options.full ? ['data', 'state', 'config', 'auth-secrets'] : BACKUP_ROOTS;
  const version = options.full ? 2 : BACKUP_FORMAT_VERSION;
  const layout = options.layout;
  if (!plain(layout) || !plain(layout.directories)) fail('runtime_boundary_violation');
  const installationRoot = layout.installationRoot;
  const roots = labels.map(label => Object.freeze({
    data: layout.directories.dataRoot,
    state: layout.directories.stateRoot,
    config: layout.directories.configRoot,
    'auth-secrets': layout.directories.authSecretsRoot,
  })[label]);
  const backupsRoot = layout.directories.backupsRoot;
  if (![installationRoot, backupsRoot, ...roots].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    fail('runtime_boundary_violation');
  }

  function snapshot(specValue, mutate) {
    const spec = validateSpec(specValue);
    if (typeof mutate !== 'function') fail('runtime_boundary_violation');
    const installation = canonicalDirectory(installationRoot);
    canonicalDirectory(backupsRoot, installation.dev);
    for (const root of roots) canonicalDirectory(root, installation.dev);
    const target = path.join(backupsRoot, spec.id);
    const temporary = path.join(backupsRoot, `.creating-${spec.id}`);
    if (path.dirname(target) !== backupsRoot || path.dirname(temporary) !== backupsRoot) fail('runtime_boundary_violation');
    if (lstatMaybe(target)) return inspect(spec);
    const required = scanRoots(roots, labels).totalBytes;
    const space = fs.statfsSync(backupsRoot);
    // Leave room for the snapshot and a full restore with the previous tree retained.
    if (space.bavail * space.bsize < required * 3 + 64 * 1024 * 1024) fail('backup_failed');
    return mutate(() => {
      if (lstatMaybe(temporary)) removeTree(temporary, installation.dev);
      makePrivate(temporary, installation.dev);
      const payload = path.join(temporary, 'payload');
      makePrivate(payload, installation.dev);
      for (const [index, label] of labels.entries()) {
        copyTree(roots[index], path.join(payload, label), installation.dev);
      }
      const scanned = scanRoots(labels.map(label => path.join(payload, label)), labels);
      const metadata = {
        version,
        backupId: spec.id,
        purpose: spec.purpose,
        manifestRevision: spec.manifestRevision,
        releaseId: spec.releaseId,
        fileCount: scanned.fileCount,
        totalBytes: scanned.totalBytes,
        treeDigest: scanned.treeDigest,
        entries: scanned.entries,
      };
      writePrivate(path.join(temporary, 'manifest.json'), `${JSON.stringify(metadata)}\n`, installation.dev);
      syncDirectory(temporary);
      fs.renameSync(temporary, target);
      syncDirectory(backupsRoot);
      return inspect({ ...spec, status: 'available', treeDigest: scanned.treeDigest,
        fileCount: scanned.fileCount, totalBytes: scanned.totalBytes });
    });
  }

  function legacy(spec) {
    if (!options.full || spec.status !== 'available') return null;
    const file = path.join(backupsRoot, identifier(spec.id), 'manifest.json');
    const device = canonicalDirectory(backupsRoot).dev;
    if (safeFile(file, device).size > 32 * 1024 * 1024) fail();
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return manifest.version === 1 ? createInstallationBackupManager({ layout }) : null;
  }

  function inspect(specValue) {
    const prior = legacy(specValue); if (prior) return prior.inspect(specValue);
    const spec = validateSpec(specValue, { source: specValue.status === 'available' });
    const installation = canonicalDirectory(installationRoot);
    canonicalDirectory(backupsRoot, installation.dev);
    const target = path.join(backupsRoot, spec.id);
    canonicalDirectory(target, installation.dev);
    const manifestFile = path.join(target, 'manifest.json');
    const info = safeFile(manifestFile, installation.dev);
    if (info.size < 2 || info.size > 32 * 1024 * 1024) fail();
    const raw = fs.readFileSync(manifestFile, 'utf8');
    if (!raw.endsWith('\n') || raw.includes('\0')) fail();
    let manifest;
    try { manifest = JSON.parse(raw.slice(0, -1)); } catch { fail(); }
    exact(manifest, [
      'version', 'backupId', 'purpose', 'manifestRevision', 'releaseId', 'fileCount',
      'totalBytes', 'treeDigest', 'entries',
    ], [
      'version', 'backupId', 'purpose', 'manifestRevision', 'releaseId', 'fileCount',
      'totalBytes', 'treeDigest', 'entries',
    ]);
    const payloadRoots = labels.map(label => path.join(target, 'payload', label));
    const scanned = scanRoots(payloadRoots, labels);
    if (manifest.version !== version || manifest.backupId !== spec.id
        || manifest.purpose !== spec.purpose || manifest.manifestRevision !== spec.manifestRevision
        || manifest.releaseId !== spec.releaseId || manifest.fileCount !== scanned.fileCount
        || manifest.totalBytes !== scanned.totalBytes || manifest.treeDigest !== scanned.treeDigest
        || JSON.stringify(manifest.entries) !== JSON.stringify(scanned.entries)
        || spec.status === 'available' && (spec.treeDigest !== scanned.treeDigest
          || spec.fileCount !== scanned.fileCount || spec.totalBytes !== scanned.totalBytes)) fail();
    return Object.freeze({
      status: 'snapshot', changed: false, fileCount: scanned.fileCount,
      totalBytes: scanned.totalBytes, treeDigest: scanned.treeDigest,
    });
  }

  function restore(sourceValue, operationIdValue, mutate) {
    const prior = legacy(sourceValue); if (prior) return prior.restore(sourceValue, operationIdValue, mutate);
    const source = validateSpec(sourceValue, { source: true });
    const operationId = identifier(operationIdValue);
    if (typeof mutate !== 'function') fail('runtime_boundary_violation');
    inspect(source);
    const installation = canonicalDirectory(installationRoot);
    const sourcePayload = path.join(backupsRoot, source.id, 'payload');
    const work = path.join(backupsRoot, `.restore-${operationId}`);
    const byLabel = rootsByLabel(roots, labels);
    return mutate(() => {
      const journalFile = path.join(work, 'journal.json');
      const committedFile = path.join(work, 'committed.json');

      function readRecord(target, requiredKeys) {
        const info = safeFile(target, installation.dev, 'lifecycle_compensation_failed');
        if (info.size < 2 || info.size > 4 * 1024) fail('lifecycle_compensation_failed');
        const raw = fs.readFileSync(target, 'utf8');
        if (!raw.endsWith('\n') || raw.includes('\0')) fail('lifecycle_compensation_failed');
        let value;
        try { value = JSON.parse(raw.slice(0, -1)); } catch { fail('lifecycle_compensation_failed'); }
        exact(value, requiredKeys, requiredKeys, 'lifecycle_compensation_failed');
        if (value.version !== 1 || value.operationId !== operationId
            || value.treeDigest !== source.treeDigest) fail('lifecycle_compensation_failed');
        return value;
      }

      function verifiedReceipt() {
        const restored = scanRoots(roots, labels);
        if (restored.treeDigest !== source.treeDigest || restored.fileCount !== source.fileCount
            || restored.totalBytes !== source.totalBytes) fail('restore_failed');
        return Object.freeze({
          status: 'restored', changed: true, fileCount: restored.fileCount,
          totalBytes: restored.totalBytes, treeDigest: restored.treeDigest,
        });
      }

      function finishCommitted() {
        readRecord(journalFile, ['version', 'operationId', 'treeDigest']);
        readRecord(committedFile, ['version', 'operationId', 'treeDigest']);
        let receipt;
        try { receipt = verifiedReceipt(); } catch { fail('lifecycle_compensation_failed'); }
        for (const label of labels) {
          removeTree(path.join(work, `previous-${label}`), installation.dev, 'lifecycle_compensation_failed');
          removeTree(path.join(work, `candidate-${label}`), installation.dev, 'lifecycle_compensation_failed');
        }
        removeTree(work, installation.dev, 'lifecycle_compensation_failed');
        syncDirectory(backupsRoot);
        return receipt;
      }

      function recoverWork() {
        if (!lstatMaybe(work)) return null;
        canonicalDirectory(work, installation.dev, 'restore_failed');
        const hasPrevious = BACKUP_ROOTS.some(label => lstatMaybe(path.join(work, `previous-${label}`)));
        if (!lstatMaybe(journalFile)) {
          if (hasPrevious) fail('lifecycle_compensation_failed');
          removeTree(work, installation.dev, 'restore_failed');
          syncDirectory(backupsRoot);
          return null;
        }
        readRecord(journalFile, ['version', 'operationId', 'treeDigest']);
        if (lstatMaybe(committedFile)) return finishCommitted();
        for (const label of [...labels].reverse()) {
          const previous = path.join(work, `previous-${label}`);
          if (!lstatMaybe(previous)) {
            if (!lstatMaybe(byLabel[label])) fail('lifecycle_compensation_failed');
            continue;
          }
          if (lstatMaybe(byLabel[label])) removeTree(byLabel[label], installation.dev, 'restore_failed');
          fs.renameSync(previous, byLabel[label]);
          syncDirectory(path.dirname(byLabel[label]));
          syncDirectory(work);
          syncDirectory(installationRoot);
        }
        removeTree(work, installation.dev, 'restore_failed');
        syncDirectory(installationRoot);
        syncDirectory(backupsRoot);
        return null;
      }
      try {
        const recovered = recoverWork();
        if (recovered) return recovered;
        makePrivate(work, installation.dev);
        for (const label of labels) {
          copyTree(path.join(sourcePayload, label), path.join(work, `candidate-${label}`), installation.dev);
        }
        const record = { version: 1, operationId, treeDigest: source.treeDigest };
        writePrivate(journalFile, `${JSON.stringify(record)}\n`, installation.dev);
        syncDirectory(work);
        syncDirectory(backupsRoot);
        for (const label of labels) {
          fs.renameSync(byLabel[label], path.join(work, `previous-${label}`));
          syncDirectory(path.dirname(byLabel[label]));
          syncDirectory(work);
          fs.renameSync(path.join(work, `candidate-${label}`), byLabel[label]);
          syncDirectory(work);
          syncDirectory(path.dirname(byLabel[label]));
        }
        verifiedReceipt();
        writePrivate(committedFile, `${JSON.stringify(record)}\n`, installation.dev);
        return finishCommitted();
      } catch (error) {
        let rollbackError = null;
        let recovered = null;
        try { recovered = recoverWork(); } catch (selected) { rollbackError = selected; }
        if (recovered) return recovered;
        if (error?.code === 'installation_operation_in_progress') throw error;
        if (rollbackError?.code === 'installation_operation_in_progress') throw rollbackError;
        if (rollbackError) fail('lifecycle_compensation_failed');
        fail('restore_failed');
      }
    });
  }

  function inspectRestored(sourceValue) {
    const prior = legacy(sourceValue); if (prior) return prior.inspectRestored(sourceValue);
    const source = validateSpec(sourceValue, { source: true });
    inspect(source);
    const installation = canonicalDirectory(installationRoot);
    for (const root of roots) canonicalDirectory(root, installation.dev, 'restore_failed');
    const restored = scanRoots(roots, labels);
    if (restored.treeDigest !== source.treeDigest || restored.fileCount !== source.fileCount
        || restored.totalBytes !== source.totalBytes) fail('restore_failed');
    return Object.freeze({
      status: 'verified', changed: false, fileCount: restored.fileCount,
      totalBytes: restored.totalBytes, treeDigest: restored.treeDigest,
    });
  }

  function destroy(approval, mutate) {
    exact(approval, ['installationState', 'retainedData', 'destructionApproved'],
      ['installationState', 'retainedData', 'destructionApproved']);
    if (approval.installationState !== 'decommissioned' || approval.retainedData !== true
        || approval.destructionApproved !== true || typeof mutate !== 'function') {
      fail('runtime_boundary_violation');
    }
    if (!lstatMaybe(installationRoot)) {
      canonicalDirectory(path.dirname(installationRoot));
      return mutate(() => {
        syncDirectory(path.dirname(installationRoot));
        if (lstatMaybe(installationRoot)) fail('destruction_failed');
        return Object.freeze({ status: 'destroyed', changed: false });
      });
    }
    const installation = canonicalDirectory(installationRoot);
    const parent = path.dirname(installationRoot);
    canonicalDirectory(parent, installation.dev, 'destruction_failed');
    return mutate(() => {
      removeTree(installationRoot, installation.dev, 'destruction_failed');
      syncDirectory(parent);
      if (lstatMaybe(installationRoot)) fail('destruction_failed');
      return Object.freeze({ status: 'destroyed', changed: true });
    });
  }

  function verifyDestroyed() {
    if (lstatMaybe(installationRoot)) fail('destruction_failed');
    return Object.freeze({ status: 'absent', changed: false });
  }

  return Object.freeze({ snapshot, inspect, restore, inspectRestored, destroy, verifyDestroyed });
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  BACKUP_ROOTS,
  createInstallationBackupManager,
};
