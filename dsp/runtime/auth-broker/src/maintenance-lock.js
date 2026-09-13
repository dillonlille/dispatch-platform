'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseStrictJson } = require('dispatch-runtime-kit/auth-broker/src/strict-json');
const { ensurePrivateDirectory } = require('./vault');

const LOCK_VERSION = 1;
const OWNER_FILE = 'owner.json';
const OWNERLESS_STALE_MS = 30_000;

class MaintenanceLockError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function fail(code) { throw new MaintenanceLockError(code); }
function bootId() {
  const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^[0-9a-f-]{36}$/.test(value)) fail('unsafe_maintenance_lock');
  return value;
}
function processStartTicks(pid) {
  try {
    const proc = fs.lstatSync(`/proc/${pid}`);
    if (!proc.isDirectory() || proc.uid !== process.geteuid()) return null;
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 1) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] || '') ? fields[19] : null;
  } catch { return null; }
}
function directoryIdentity(file) {
  let info;
  try { info = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o777) !== 0o700 || fs.realpathSync(file) !== file) fail('unsafe_maintenance_lock');
  return { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs };
}
function sameIdentity(left, right) { return Boolean(left && right && left.dev === right.dev && left.ino === right.ino); }
function ownerPath(lockPath) { return path.join(lockPath, OWNER_FILE); }
function readOwner(lockPath) {
  const file = ownerPath(lockPath);
  let info;
  try { info = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 1024 || fs.realpathSync(file) !== file) {
    fail('unsafe_maintenance_lock');
  }
  let value;
  try { value = parseStrictJson(fs.readFileSync(file, 'utf8')); } catch { fail('unsafe_maintenance_lock'); }
  if (!value || Object.keys(value).sort().join(',') !== 'bootId,pid,startTicks,version'
      || value.version !== LOCK_VERSION || !Number.isInteger(value.pid) || value.pid < 2
      || !/^[0-9a-f-]{36}$/.test(value.bootId) || !/^\d+$/.test(value.startTicks)) fail('unsafe_maintenance_lock');
  return value;
}
function ownerAlive(owner) {
  return owner.bootId === bootId() && processStartTicks(owner.pid) === owner.startTicks;
}
function removeStale(lockPath, identity) {
  const current = directoryIdentity(lockPath);
  if (!sameIdentity(identity, current)) fail('maintenance_busy');
  const stale = `${lockPath}.stale-${crypto.randomUUID()}`;
  fs.renameSync(lockPath, stale);
  fs.rmSync(stale, { recursive: true, force: false });
}

function acquireMaintenanceLock(paths) {
  ensurePrivateDirectory(paths.stateRoot);
  const lockPath = path.join(paths.stateRoot, 'maintenance.lock');
  if (path.resolve(lockPath) !== lockPath || path.dirname(lockPath) !== path.resolve(paths.stateRoot)) fail('unsafe_maintenance_lock');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      const identity = directoryIdentity(lockPath);
      const owner = {
        version: LOCK_VERSION,
        pid: process.pid,
        bootId: bootId(),
        startTicks: processStartTicks(process.pid),
      };
      if (!owner.startTicks) fail('unsafe_maintenance_lock');
      fs.writeFileSync(ownerPath(lockPath), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
      const written = readOwner(lockPath);
      if (!ownerAlive(written) || written.pid !== owner.pid) fail('unsafe_maintenance_lock');
      let released = false;
      return () => {
        if (released) return;
        const current = directoryIdentity(lockPath);
        const currentOwner = readOwner(lockPath);
        if (!sameIdentity(identity, current) || !currentOwner || currentOwner.pid !== owner.pid
            || currentOwner.bootId !== owner.bootId || currentOwner.startTicks !== owner.startTicks) fail('unsafe_maintenance_lock');
        fs.unlinkSync(ownerPath(lockPath));
        fs.rmdirSync(lockPath);
        released = true;
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (created) try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}
        if (error instanceof MaintenanceLockError) throw error;
        fail('unsafe_maintenance_lock');
      }
      const identity = directoryIdentity(lockPath);
      const owner = readOwner(lockPath);
      if (owner && ownerAlive(owner)) fail('maintenance_busy');
      if (!owner && Date.now() - identity.mtimeMs < OWNERLESS_STALE_MS) fail('maintenance_busy');
      removeStale(lockPath, identity);
    }
  }
  fail('maintenance_busy');
}

module.exports = { acquireMaintenanceLock, MaintenanceLockError, bootId, processStartTicks };
