'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ISSUER = 'dispatch-access-control';
const AUDIENCE = 'dispatch-oci-host-v1';
const DATABASE = 'authority.sqlite3';
const RETIRED_READS = Object.freeze(['inspect_account', 'verify_destroyed']);
const SCHEMA = [
  `CREATE TABLE leases (
    runtime_key TEXT PRIMARY KEY,
    lease_json TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0),
    fence INTEGER NOT NULL CHECK(fence>0),
    state TEXT NOT NULL CHECK(state IN ('active','revoked','retired'))
  ) STRICT`,
  `CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    runtime_key TEXT NOT NULL REFERENCES leases(runtime_key),
    request_digest TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>0),
    fence INTEGER NOT NULL CHECK(fence>0),
    state TEXT NOT NULL CHECK(state IN ('issued','running','consumed'))
  ) STRICT`,
];

function fail() {
  throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' });
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,95}$/.test(value)) fail();
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function requestDigest(request) {
  const { authorization, ...body } = request;
  const encoded = canonical(body);
  if (Buffer.byteLength(encoded) > 256 * 1024) fail();
  return crypto.createHash('sha256').update(encoded).digest('hex');
}
function validateLease(value, now) {
  exact(value, ['version', 'issuer', 'audience', 'organizationId', 'runtimeKey', 'installationRevision', 'manifestRevisions',
    'backend', 'jobKind', 'jobId', 'workerId', 'generation', 'fence', 'expiresAt']);
  for (const field of ['organizationId', 'runtimeKey', 'jobId', 'workerId']) identifier(value[field]);
  for (const field of ['installationRevision', 'generation', 'fence', 'expiresAt']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1) fail();
  }
  if (!Array.isArray(value.manifestRevisions) || ![1, 2].includes(value.manifestRevisions.length)
      || value.manifestRevisions.some(item => !Number.isSafeInteger(item) || item < 1)
      || value.manifestRevisions.length === 2 && value.manifestRevisions[1] !== value.manifestRevisions[0] + 1) fail();
  if (value.version !== 1 || value.issuer !== ISSUER || value.audience !== AUDIENCE
      || !['provisioning', 'lifecycle'].includes(value.jobKind)
      || !['oci_container_v1', 'native_service_v1'].includes(value.backend) || value.runtimeKey === 'local'
      || value.expiresAt <= now || value.expiresAt > now + 600_000) fail();
  return value;
}
function protectedDirectory(target, mode) {
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o7777) !== mode || fs.realpathSync(target) !== target) fail();
  return info;
}

// This API belongs ONLY to the independently protected authority process. It is
// deliberately absent from the sudo helper's wire protocol. The ordinary worker
// cannot issue, renew, revoke, or edit a lease or an action.
function createOciHostAuthority({ root, clock = Date.now }) {
  if (process.geteuid() !== 0 || process.getegid() !== 0 || typeof root !== 'string'
      || !path.isAbsolute(root) || path.resolve(root) !== root || typeof clock !== 'function') fail();
  const rootInfo = protectedDirectory(root, 0o700);
  for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
    const info = fs.lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
        || (info.mode & 0o022) !== 0 || fs.realpathSync(parent) !== parent) fail();
    if (parent === '/') break;
  }
  const file = path.join(root, DATABASE);
  const entries = fs.readdirSync(root);
  if (entries.some(entry => ![DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`].includes(entry))) fail();
  let created = false;
  try {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
    created = true;
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  function privateFile(target) {
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
        || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.dev !== rootInfo.dev
        || fs.realpathSync(target) !== target) fail();
    return info;
  }
  const fileInfo = privateFile(file);
  for (const entry of entries) privateFile(path.join(root, entry));
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=30000;');
    db.exec('BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const tables = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
    if (version === 0 && tables.length === 0 && (created || fileInfo.size === 0)) {
      for (const sql of SCHEMA) db.exec(sql);
      db.exec('PRAGMA user_version=1');
    }
    const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
    const normalize = value => value.replace(/\s+/g, ' ').trim();
    if (db.prepare('PRAGMA user_version').get().user_version !== 1
        || JSON.stringify(schema.map(row => normalize(row.sql))) !== JSON.stringify([SCHEMA[1], SCHEMA[0]].map(normalize))
        || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail();
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
  let closed = false;
  function check() {
    if (closed) fail();
    const current = protectedDirectory(root, 0o700);
    const currentFile = privateFile(file);
    if (current.dev !== rootInfo.dev || current.ino !== rootInfo.ino
        || currentFile.dev !== fileInfo.dev || currentFile.ino !== fileInfo.ino) fail();
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    return now;
  }
  function transaction(callback) {
    check();
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function issueLease(value) {
    const lease = validateLease(value, check());
    return transaction(() => replaceLease(lease));
  }
  function replaceLease(lease) {
      if (db.prepare("SELECT 1 FROM actions WHERE runtime_key=? AND state='running'").get(lease.runtimeKey)) fail();
      const prior = db.prepare('SELECT * FROM leases WHERE runtime_key=?').get(lease.runtimeKey);
      const priorLease = prior && JSON.parse(prior.lease_json);
      if (prior && (prior.state === 'retired' || lease.installationRevision < priorLease.installationRevision
          || lease.installationRevision === priorLease.installationRevision
            && (lease.generation < prior.generation
              || lease.generation === prior.generation && lease.fence <= prior.fence))) fail();
      db.prepare(`INSERT INTO leases VALUES(?,?,?,?, 'active') ON CONFLICT(runtime_key) DO UPDATE SET
        lease_json=excluded.lease_json,generation=excluded.generation,fence=excluded.fence,state='active'`)
        .run(lease.runtimeKey, canonical(lease), lease.generation, lease.fence);
  }
  function renewLease(value) {
    const lease = validateLease(value, check());
    return transaction(() => {
      const current = currentLease(lease.runtimeKey);
      if (canonical({ ...current, expiresAt: lease.expiresAt }) !== canonical(lease)
          || lease.expiresAt < current.expiresAt) fail();
      db.prepare('UPDATE leases SET lease_json=? WHERE runtime_key=?').run(canonical(lease), lease.runtimeKey);
    });
  }
  function currentLease(runtimeKey, operation) {
    const row = db.prepare('SELECT * FROM leases WHERE runtime_key=?').get(runtimeKey);
    if (!row || row.state !== 'active' && !(row.state === 'retired' && RETIRED_READS.includes(operation))) fail();
    return validateLease(JSON.parse(row.lease_json), check());
  }
  function bound(request, lease) {
    const fields = lease.jobKind === 'provisioning' ? ['jobId', 'workerId', 'generation', 'fence']
      : ['jobId', 'workerId', 'fence'];
    exact(request.claim, fields);
    for (const field of fields) {
      if (request.claim[field] !== lease[field]) fail();
    }
    const runtimeKey = request.plan?.runtimeKey ?? request.runtimeKey;
    if (runtimeKey !== lease.runtimeKey) fail();
    if (request.plan && (request.plan.backend !== lease.backend
        || request.plan.deployment?.organizationId !== lease.organizationId
        || !lease.manifestRevisions.includes(request.plan.deployment?.manifestRevision))) fail();
  }
  // Call only after deriving the request from the server-owned job/stage,
  // manifest, release catalog, account allocation and backup/destruction record.
  function issueAction(request) {
    return transaction(() => {
      const runtimeKey = request.plan?.runtimeKey ?? request.runtimeKey;
      if (db.prepare("SELECT 1 FROM actions WHERE runtime_key=? AND state='running'").get(runtimeKey)) fail();
      const lease = currentLease(runtimeKey, request.operation);
      bound(request, lease);
      const id = crypto.randomBytes(32).toString('hex');
      db.prepare("INSERT INTO actions VALUES(?,?,?,?,?,'issued')")
        .run(id, runtimeKey, requestDigest(request), lease.generation, lease.fence);
      return id;
    });
  }
  function revoke(runtimeKey, retired = false) {
    identifier(runtimeKey);
    if (typeof retired !== 'boolean') fail();
    return transaction(() => {
      const row = db.prepare('SELECT state FROM leases WHERE runtime_key=?').get(runtimeKey);
      if (!row) fail();
      if (row.state === 'retired') return;
      db.prepare('UPDATE leases SET state=? WHERE runtime_key=?').run(retired ? 'retired' : 'revoked', runtimeKey);
    });
  }
  function validateAction(request, state) {
    if (typeof request.authorization !== 'string' || !/^[a-f0-9]{64}$/.test(request.authorization)) fail();
    const row = db.prepare('SELECT * FROM actions WHERE id=?').get(request.authorization);
    if (!row || row.state !== state || row.request_digest !== requestDigest(request)) fail();
    const lease = currentLease(row.runtime_key, request.operation);
    bound(request, lease);
    if (row.generation !== lease.generation || row.fence !== lease.fence) fail();
  }
  function execute(request, callback) {
    if (typeof callback !== 'function') fail();
    // Persist the in-flight gate before effects. If this process dies, a child
    // or systemd job can outlive its SQLite lock. Refuse takeover and new actions
    // until a trusted recovery procedure proves those effects have quiesced.
    transaction(() => {
      validateAction(request, 'issued');
      const row = db.prepare('SELECT runtime_key FROM actions WHERE id=?').get(request.authorization);
      if (db.prepare("SELECT 1 FROM actions WHERE runtime_key=? AND state='running'").get(row.runtime_key)) fail();
      db.prepare("UPDATE actions SET state='running' WHERE id=?").run(request.authorization);
    });
    return transaction(() => {
      validateAction(request, 'running');
      const guard = mutation => {
        validateAction(request, 'running');
        const result = mutation();
        if (result && typeof result.then === 'function') fail();
        return result;
      };
      Object.defineProperty(guard, 'remainingMs', { value: () => {
        validateAction(request, 'running');
        const row = db.prepare('SELECT runtime_key FROM actions WHERE id=?').get(request.authorization);
        const remaining = currentLease(row.runtime_key, request.operation).expiresAt - check();
        if (!Number.isSafeInteger(remaining) || remaining < 1) fail();
        return remaining;
      } });
      // The write lock serializes takeover, revocation and retirement with every
      // host effect. Executor subprocesses remain bounded by their fixed timeouts.
      const result = callback(guard);
      if (result && typeof result.then === 'function') fail();
      db.prepare("UPDATE actions SET state='consumed' WHERE id=?").run(request.authorization);
      return result;
    });
  }
  // Used only by the protected issuer, after live Access Control validation.
  // Each synchronous dispatch revokes its lease on return; it may be renewed
  // for another request by the same still-current server claim.
  function synchronizeLease(value, operation) {
    const lease = validateLease(value, check());
    return transaction(() => {
      const prior = db.prepare('SELECT * FROM leases WHERE runtime_key=?').get(lease.runtimeKey);
      if (prior?.state === 'retired') {
        const before = JSON.parse(prior.lease_json);
        if (!RETIRED_READS.includes(operation) || lease.jobKind !== 'lifecycle'
            || lease.organizationId !== before.organizationId
            || lease.installationRevision < before.installationRevision
            || lease.installationRevision === before.installationRevision
              && (lease.generation < before.generation
                || lease.generation === before.generation && lease.fence < before.fence)
            || db.prepare("SELECT 1 FROM actions WHERE runtime_key=? AND state='running'").get(lease.runtimeKey)) fail();
        db.prepare("UPDATE leases SET lease_json=?,generation=?,fence=? WHERE runtime_key=?")
          .run(canonical(lease), lease.generation, lease.fence, lease.runtimeKey);
        return;
      }
      if (prior && prior.state !== 'retired') {
        const before = JSON.parse(prior.lease_json);
        if (canonical({ ...before, expiresAt: lease.expiresAt }) === canonical(lease)) {
          if (db.prepare("SELECT 1 FROM actions WHERE runtime_key=? AND state='running'").get(lease.runtimeKey)) fail();
          db.prepare("UPDATE leases SET lease_json=?,state='active' WHERE runtime_key=?")
            .run(canonical(lease), lease.runtimeKey);
          return;
        }
      }
      return replaceLease(lease);
    });
  }
  function recover(runtimeKey, quiesce) {
    identifier(runtimeKey);
    if (typeof quiesce !== 'function') fail();
    return transaction(() => {
      const rows = db.prepare("SELECT id FROM actions WHERE runtime_key=? AND state='running'").all(runtimeKey);
      if (!rows.length) return false;
      // The callback must synchronously prove that the operation cgroup and
      // delegated systemd jobs have stopped. An exception retains the gate.
      if (quiesce(Object.freeze(rows.map(row => row.id))) !== true) fail();
      db.prepare("UPDATE actions SET state='consumed' WHERE runtime_key=? AND state='running'").run(runtimeKey);
      db.prepare("UPDATE leases SET state='revoked' WHERE runtime_key=? AND state!='retired'").run(runtimeKey);
      return true;
    });
  }
  return Object.freeze({ issueLease, renewLease, synchronizeLease, issueAction, revoke, recover, execute,
    close() { if (!closed) db.close(); closed = true; } });
}

module.exports = { ISSUER, AUDIENCE, createOciHostAuthority, requestDigest };
