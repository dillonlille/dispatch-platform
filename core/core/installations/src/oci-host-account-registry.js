'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { INSTALLATION_IDENTIFIER_RE } = require('../../../shared/contracts/src/installation');
const { hostAccountName } = require('../../runtime-host-identity');
const { SUBID_COUNT } = require('./oci-deployment');

const OCI_HOST_REGISTRY_SCHEMA_VERSION = 1;
const OCI_HOST_REGISTRY_DATABASE = 'oci-host.sqlite3';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ALLOCATIONS_SCHEMA_SQL = `CREATE TABLE allocations (
        runtime_key TEXT PRIMARY KEY,
        account_name TEXT NOT NULL UNIQUE,
        uid INTEGER NOT NULL UNIQUE CHECK(uid BETWEEN 100 AND 60000),
        gid INTEGER NOT NULL UNIQUE CHECK(gid BETWEEN 100 AND 60000),
        subuid_start INTEGER NOT NULL UNIQUE CHECK(subuid_start>=100000),
        subgid_start INTEGER NOT NULL UNIQUE CHECK(subgid_start>=100000),
        subid_count INTEGER NOT NULL CHECK(subid_count=65536),
        status TEXT NOT NULL CHECK(status IN ('reserved','active','retired')),
        created_at INTEGER NOT NULL CHECK(created_at>=0),
        updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
      ) STRICT`;

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\0\r\n]/.test(value)) fail();
  return value;
}

function directory(target) {
  let info;
  try { info = fs.lstatSync(target); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE || fs.realpathSync(target) !== target) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function databaseFile(target, device, allowEmpty = false) {
  let info;
  try { info = fs.lstatSync(target); } catch { fail(); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || info.dev !== device || (info.mode & 0o7777) !== PRIVATE_FILE_MODE
      || (!allowEmpty && info.size < 1) || info.size > 16 * 1024 * 1024
      || fs.realpathSync(target) !== target) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function runtimeKey(value) {
  if (typeof value !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value) || value === 'local') fail();
  return value;
}

function positiveInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function parseRanges(file) {
  const result = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { fail(); }
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024 || raw.includes('\0') || raw.includes('\r')) fail();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split(':');
    const start = Number(parts[1]);
    const count = Number(parts[2]);
    if (parts.length !== 3 || !parts[0] || !Number.isSafeInteger(start)
        || !Number.isSafeInteger(count) || start < 0 || count < 1
        || start + count - 1 > 4_294_967_294) fail();
    result.push(Object.freeze({ start, end: start + count - 1 }));
  }
  return result;
}

function overlaps(start, count, range) {
  const end = start + count - 1;
  return start <= range.end && end >= range.start;
}

function view(row) {
  if (!row) return null;
  return Object.freeze({
    runtimeKey: row.runtime_key,
    name: row.account_name,
    uid: row.uid,
    gid: row.gid,
    subuidStart: row.subuid_start,
    subgidStart: row.subgid_start,
    subidCount: row.subid_count,
    status: row.status,
  });
}

function createOciHostAccountRegistry(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => ![
        'stateRoot', 'uidMinimum', 'uidMaximum', 'subidMinimum', 'subuidFile', 'subgidFile',
        'identityAvailable', 'clock',
      ].includes(key))) fail();
  const stateRoot = absolute(options.stateRoot);
  const rootIdentity = directory(stateRoot);
  const uidMinimum = positiveInteger(options.uidMinimum === undefined ? 20_000 : options.uidMinimum, 100, 60_000);
  const uidMaximum = positiveInteger(options.uidMaximum === undefined ? 59_999 : options.uidMaximum, uidMinimum, 60_000);
  const subidMinimum = positiveInteger(options.subidMinimum === undefined ? 1_000_000 : options.subidMinimum, 100_000, 4_000_000_000);
  const subuidFile = absolute(options.subuidFile === undefined ? '/etc/subuid' : options.subuidFile);
  const subgidFile = absolute(options.subgidFile === undefined ? '/etc/subgid' : options.subgidFile);
  const identityAvailable = options.identityAvailable;
  const clock = options.clock === undefined ? Date.now : options.clock;
  if (typeof identityAvailable !== 'function' || typeof clock !== 'function') fail();
  const file = path.join(stateRoot, OCI_HOST_REGISTRY_DATABASE);
  const existing = (() => { try { fs.lstatSync(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } })();
  if (existing) databaseFile(file, rootIdentity.dev, true);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${file}${suffix}`;
    try { fs.lstatSync(sidecar); databaseFile(sidecar, rootIdentity.dev, true); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  let db;
  try {
    db = new DatabaseSync(file);
    if (!existing) fs.chmodSync(file, PRIVATE_FILE_MODE);
    databaseFile(file, rootIdentity.dev, !existing);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=30000;`);
    db.exec('BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const initialSchema = db.prepare('SELECT name FROM sqlite_schema').all();
    if (version === 0 && initialSchema.length === 0) db.exec(`${ALLOCATIONS_SCHEMA_SQL}; PRAGMA user_version=1;`);
    if (db.prepare('PRAGMA user_version').get().user_version !== OCI_HOST_REGISTRY_SCHEMA_VERSION
        || db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') fail();
    const columns = db.prepare('PRAGMA table_info(allocations)').all().map(row => row.name);
    if (JSON.stringify(columns) !== JSON.stringify([
      'runtime_key', 'account_name', 'uid', 'gid', 'subuid_start', 'subgid_start', 'subid_count',
      'status', 'created_at', 'updated_at',
    ])) fail();
    const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='allocations'").get()?.sql;
    const definitions = db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all();
    const normalize = value => String(value).replace(/\s+/g, ' ').trim().replace(/\s*([(),=])\s*/g, '$1');
    if (definitions.length !== 1 || normalize(schema) !== normalize(ALLOCATIONS_SCHEMA_SQL)) fail();
    db.exec('COMMIT');
  } catch (error) {
    try { db?.close(); } catch {}
    if (error?.code === 'runtime_boundary_violation') throw error;
    fail();
  }
  let closed = false;
  const databaseIdentity = databaseFile(file, rootIdentity.dev);

  function assertOpen() {
    if (closed) fail('installation_operation_failed');
    const current = directory(stateRoot);
    if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) fail();
    const currentDatabase = databaseFile(file, rootIdentity.dev);
    if (currentDatabase.dev !== databaseIdentity.dev || currentDatabase.ino !== databaseIdentity.ino) fail();
  }

  function inspect(keyValue) {
    assertOpen();
    const key = runtimeKey(keyValue);
    return view(db.prepare('SELECT * FROM allocations WHERE runtime_key=?').get(key));
  }

  function reserve(keyValue) {
    assertOpen();
    const key = runtimeKey(keyValue);
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT * FROM allocations WHERE runtime_key=?').get(key);
      if (prior) {
        db.exec('COMMIT');
        return view(prior);
      }
      let uid = null;
      const allocatedUids = new Set(db.prepare('SELECT uid FROM allocations').all().map(row => row.uid));
      for (let candidate = uidMinimum; candidate <= uidMaximum; candidate += 1) {
        if (!allocatedUids.has(candidate) && identityAvailable(candidate)) { uid = candidate; break; }
      }
      if (uid === null) fail('service_installation_failed');
      const occupied = [
        ...parseRanges(subuidFile),
        ...parseRanges(subgidFile),
        ...db.prepare('SELECT subuid_start,subgid_start,subid_count FROM allocations').all()
          .flatMap(row => [
            { start: row.subuid_start, end: row.subuid_start + row.subid_count - 1 },
            { start: row.subgid_start, end: row.subgid_start + row.subid_count - 1 },
          ]),
      ];
      let subid = Math.ceil(subidMinimum / SUBID_COUNT) * SUBID_COUNT;
      while (occupied.some(range => overlaps(subid, SUBID_COUNT, range))) {
        subid += SUBID_COUNT;
        if (subid + SUBID_COUNT - 1 > 4_294_967_294) fail('service_installation_failed');
      }
      const at = clock();
      if (!Number.isSafeInteger(at) || at < 0) fail('installation_operation_failed');
      db.prepare(`INSERT INTO allocations(
        runtime_key,account_name,uid,gid,subuid_start,subgid_start,subid_count,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'reserved',?,?)`).run(
        key, hostAccountName(key), uid, uid, subid, subid, SUBID_COUNT, at, at,
      );
      const selected = db.prepare('SELECT * FROM allocations WHERE runtime_key=?').get(key);
      db.exec('COMMIT');
      return view(selected);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if (error?.code) throw error;
      fail('service_installation_failed');
    }
  }

  function transition(keyValue, from, to) {
    assertOpen();
    const key = runtimeKey(keyValue);
    if (!['reserved', 'active'].includes(from) || !['active', 'retired'].includes(to)) fail();
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0) fail('installation_operation_failed');
    const changed = db.prepare('UPDATE allocations SET status=?,updated_at=? WHERE runtime_key=? AND status=?')
      .run(to, at, key, from).changes;
    if (changed !== 1) fail('installation_operation_in_progress');
    return inspect(key);
  }

  function activate(key) {
    const current = inspect(key);
    return current?.status === 'active' ? current : transition(key, 'reserved', 'active');
  }
  function retire(key) {
    const current = inspect(key);
    return current?.status === 'retired' ? current : transition(key, 'active', 'retired');
  }
  function close() { if (!closed) db.close(); closed = true; }

  return Object.freeze({ reserve, inspect, activate, retire, close });
}

module.exports = {
  OCI_HOST_REGISTRY_SCHEMA_VERSION,
  OCI_HOST_REGISTRY_DATABASE,
  ALLOCATIONS_SCHEMA_SQL,
  createOciHostAccountRegistry,
};
