'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');
const { defaultPaths } = require('../../auth-broker/src/paths');
const { parseStrictJson } = require('dispatch-runtime-kit/auth-broker/src/strict-json');
const { ensurePrivateDirectory } = require('../../auth-broker/src/vault');
const { safeExecutable, helperEnvironment, runJson } = require('./process-helper');
const { AUTH_PROTOCOL_VERSION } = require('dispatch-protocol/contracts/src/auth');

const AUTH_ROOT = path.resolve(__dirname, "../../auth-broker");
const BROKER_EXECUTABLE = path.join(AUTH_ROOT, 'bin/dispatch-auth-broker');
const SIGNAL_HELPER = path.join(AUTH_ROOT, 'bin/dispatch-auth-broker-signal');
const SERVICE_VERSION = 1;
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_MS = 25;
const BOOT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function serviceFile(paths) {
  const file = paths.service || path.join(paths.stateRoot, 'auth-broker-service.json');
  if (path.resolve(paths.stateRoot) !== paths.stateRoot || path.resolve(file) !== file || path.dirname(file) !== paths.stateRoot) fail('unsafe_service_state');
  return file;
}
function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function bootId() {
  let value;
  try { value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { fail('service_identity_unavailable'); }
  if (!BOOT_ID_RE.test(value)) fail('service_identity_unavailable');
  return value;
}
function processIdentity(pid, executable = BROKER_EXECUTABLE) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  try {
    const root = `/proc/${pid}`;
    const owner = fs.lstatSync(root);
    if (!owner.isDirectory() || owner.uid !== process.geteuid()) return null;
    const raw = fs.readFileSync(path.join(root, 'stat'), 'utf8');
    const end = raw.lastIndexOf(')');
    if (end < 1) return null;
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!/^\d+$/.test(startTicks)) return null;
    const argv = fs.readFileSync(path.join(root, 'cmdline')).toString('utf8').split('\0').filter(Boolean);
    if (!argv.includes(executable)) return null;
    return { bootId: bootId(), startTicks };
  } catch { return null; }
}
function validateRecord(value, executable = BROKER_EXECUTABLE) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'bootId,createdAt,executable,pid,startTicks,version'
      || value.version !== SERVICE_VERSION || value.executable !== executable
      || !Number.isInteger(value.pid) || value.pid < 2 || !BOOT_ID_RE.test(value.bootId)
      || typeof value.startTicks !== 'string' || !/^\d+$/.test(value.startTicks)
      || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) fail('unsafe_service_state');
  return value;
}
function readRecord(paths, executable = BROKER_EXECUTABLE) {
  const file = serviceFile(paths);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error?.code === 'ENOENT') return null; fail('unsafe_service_state'); }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size < 2 || info.size > 4096
        || fs.realpathSync(`/proc/self/fd/${fd}`) !== file) fail('unsafe_service_state');
    const text = fs.readFileSync(fd, 'utf8');
    return { value: validateRecord(parseStrictJson(text.trim()), executable), identity: { dev: info.dev, ino: info.ino }, file };
  } catch (error) {
    if (error?.code === 'unsafe_service_state') throw error;
    fail('unsafe_service_state');
  } finally { fs.closeSync(fd); }
}
function sameProcess(record, identity) {
  return Boolean(record && identity && record.bootId === identity.bootId && record.startTicks === identity.startTicks);
}
function signalManaged(record, signal) {
  const result = runJson(SIGNAL_HELPER, [
    String(record.pid), record.bootId, record.startTicks, signal === 'SIGTERM' ? 'TERM' : 'KILL',
  ], {
    timeout: 2_000,
    validate: value => !value.ok
      || (Object.keys(value).sort().join(',') === 'ok,signalled,status' && value.signalled === true),
  });
  if (!result.value.ok) fail('auth_broker_stop_failed');
}
function writeRecord(paths, value) {
  ensurePrivateDirectory(paths.stateRoot);
  const file = serviceFile(paths);

  const temporary = path.join(paths.stateRoot, `.auth-service-${crypto.randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(temporary, file);
    fs.unlinkSync(temporary);
    fsyncDirectory(paths.stateRoot);
  } catch (error) {
    if (fd !== null && fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    if (error?.code === 'EEXIST') fail('service_state_exists');
    if (error?.code) fail('unsafe_service_state');
    throw error;
  }
}
function removeRecord(entry, paths) {
  if (!entry) return;
  const current = fs.lstatSync(entry.file);
  if (!current.isFile() || current.dev !== entry.identity.dev || current.ino !== entry.identity.ino
      || current.uid !== process.geteuid() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) fail('unsafe_service_state');
  fs.unlinkSync(entry.file);
  fsyncDirectory(paths.stateRoot);
}

class LocalAuthBrokerServicePort {
  #paths; #request; #spawn; #signal; #identity; #delay; #clock; #environment;

  constructor({
    paths = defaultPaths(), requestImpl = request, spawnImpl = spawn, signalImpl = null, killImpl = null,
    identityImpl = processIdentity, delayImpl = delay, clock = () => Date.now(), environment = {},
  } = {}) {
    this.#paths = paths;
    this.#request = requestImpl;
    this.#spawn = spawnImpl;
    this.#signal = signalImpl || (killImpl ? (record, signal) => killImpl(record.pid, signal) : signalManaged);
    this.#identity = identityImpl;
    this.#delay = delayImpl;
    this.#clock = clock;
    this.#environment = environment;
  }

  async #health({ allowProtocolMismatch = false } = {}) {
    try {
      const value = await this.#request(this.#paths.socket, { action: 'health' }, { timeoutMs: 500 });
      if (value?.ok !== true || value.status !== 'ready' || value.vault?.verified !== true) fail('invalid_component_response');
      if (value.protocolVersion !== AUTH_PROTOCOL_VERSION) {
        if (allowProtocolMismatch) return false;
        fail('invalid_component_response');
      }
      return true;
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error?.code)) return false;
      if (error?.code === 'invalid_component_response') throw error;
      if (['broker_timeout', 'invalid_response'].includes(error?.message)) fail('broker_state_unknown');
      fail('broker_state_unknown');
    }
  }

  #recordState() {
    const entry = readRecord(this.#paths);
    if (!entry) return { entry: null, alive: false };
    const identity = this.#identity(entry.value.pid, BROKER_EXECUTABLE);
    return { entry, alive: sameProcess(entry.value, identity) };
  }

  async status() {
    const healthy = await this.#health();
    const record = this.#recordState();
    if (healthy) return { status: 'ready', managed: record.alive };
    if (record.alive) return { status: 'starting', managed: true };
    return { status: 'stopped', managed: false };
  }

  async #waitReady(entry, timeoutMs = START_TIMEOUT_MS) {
    const deadline = this.#clock() + timeoutMs;
    while (this.#clock() < deadline) {
      if (!sameProcess(entry.value, this.#identity(entry.value.pid, BROKER_EXECUTABLE))) return false;
      try { if (await this.#health()) return true; } catch (error) { if (error?.code !== 'broker_state_unknown') throw error; }
      await this.#delay(POLL_MS);
    }
    return false;
  }

  async #waitStopped(entry, timeoutMs) {
    const deadline = this.#clock() + timeoutMs;
    while (this.#clock() < deadline) {
      if (!sameProcess(entry.value, this.#identity(entry.value.pid, BROKER_EXECUTABLE))) return true;
      await this.#delay(POLL_MS);
    }
    return !sameProcess(entry.value, this.#identity(entry.value.pid, BROKER_EXECUTABLE));
  }

  async #terminate(entry) {
    if (!sameProcess(entry.value, this.#identity(entry.value.pid, BROKER_EXECUTABLE))) return;
    try { this.#signal(entry.value, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') fail('auth_broker_stop_failed'); }
    if (!(await this.#waitStopped(entry, STOP_TIMEOUT_MS))) {
      if (!sameProcess(entry.value, this.#identity(entry.value.pid, BROKER_EXECUTABLE))) return;
      try { this.#signal(entry.value, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') fail('auth_broker_stop_failed'); }
      if (!(await this.#waitStopped(entry, 2_000))) fail('auth_broker_stop_failed');
    }
  }

  async start() {
    safeExecutable(BROKER_EXECUTABLE);
    safeExecutable(SIGNAL_HELPER);
    const existing = this.#recordState();
    if (await this.#health()) return { status: 'ready', managed: existing.alive, started: false };
    if (existing.alive) {
      if (await this.#waitReady(existing.entry)) return { status: 'ready', managed: true, started: false };
      fail('auth_broker_start_failed');
    }
    if (existing.entry) removeRecord(existing.entry, this.#paths);

    let child;
    try {
      child = this.#spawn(BROKER_EXECUTABLE, [], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
        env: helperEnvironment(this.#environment),
      });
    } catch { fail('auth_broker_start_failed'); }
    if (!child || !Number.isInteger(child.pid) || child.pid < 2) fail('auth_broker_start_failed');
    child.on?.('error', () => {});

    let identity = null;
    const identityDeadline = this.#clock() + 1_000;
    while (!identity && this.#clock() < identityDeadline) {
      identity = this.#identity(child.pid, BROKER_EXECUTABLE);
      if (!identity) await this.#delay(POLL_MS);
    }
    if (!identity) fail('auth_broker_start_failed');
    const value = {
      version: SERVICE_VERSION,
      pid: child.pid,
      bootId: identity.bootId,
      startTicks: identity.startTicks,
      executable: BROKER_EXECUTABLE,
      createdAt: new Date(this.#clock()).toISOString(),
    };
    try { writeRecord(this.#paths, value); }
    catch (error) { try { signalManaged(value, 'SIGTERM'); } catch {} throw error; }
    child.unref?.();
    const entry = readRecord(this.#paths);
    if (!entry || !sameProcess(entry.value, identity)) {
      try { signalManaged(value, 'SIGTERM'); } catch {}
      fail('unsafe_service_state');
    }
    let ready = false;
    let readinessError = null;
    try { ready = await this.#waitReady(entry); }
    catch (error) { readinessError = error; }
    if (!ready) {
      await this.#terminate(entry);
      removeRecord(entry, this.#paths);
      if (readinessError) throw readinessError;
      fail('auth_broker_start_failed');
    }
    return { status: 'ready', managed: true, started: true };
  }

  async stop() {
    const healthy = await this.#health({ allowProtocolMismatch: true });
    const record = this.#recordState();
    if (!record.entry) {
      if (healthy) fail('auth_broker_unmanaged');
      return { status: 'stopped', managed: false, stopped: false };
    }
    if (!record.alive) {
      removeRecord(record.entry, this.#paths);
      if (healthy) fail('auth_broker_unmanaged');
      return { status: 'stopped', managed: false, stopped: false };
    }
    await this.#terminate(record.entry);
    removeRecord(record.entry, this.#paths);
    if (await this.#health()) fail('auth_broker_stop_failed');
    return { status: 'stopped', managed: true, stopped: true };
  }

  async restart() {
    const status = await this.status();
    if (status.status === 'ready' && !status.managed) fail('auth_broker_unmanaged');
    await this.stop();
    return this.start();
  }
}

module.exports = {
  LocalAuthBrokerServicePort, BROKER_EXECUTABLE, SERVICE_VERSION, START_TIMEOUT_MS, STOP_TIMEOUT_MS,
  bootId, processIdentity, validateRecord, readRecord, writeRecord, removeRecord, sameProcess,
};
