'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { platformPaths } = require('../../../shared/paths/platform-paths');
const { ensureDsp, inspectDsp } = require('../../../host/storage/storage');
const { acquireLock } = require('../../../host/controller/operations');
const { DirectoryJournal } = require('../../../host/controller/journal');
const { DirectoryManager } = require('../../../host/controller/manager');
const { request } = require('../../../host/controller/controller');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-lifecycle-'));
  for (const name of ['live', 'local', 'dsps', 'dev', 'worktrees']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return platformPaths(root);
}

function manager(paths) {
  const active = new Set(), starts = [], stops = [];
  const host = { prepare: async () => {}, start: async id => { starts.push(id); active.add(id); },
    stop: async id => { stops.push(id); active.delete(id); } };
  const hub = { connected: id => active.has(id), invoke: async () => ({ ok: true }) };
  const value = new DirectoryManager({ paths, host, hub });
  value.bridge = async () => {};
  return { value, host, active, starts, stops };
}

test('operation lock excludes another process and is released after a controller crash', async t => {
  const paths = fixture(t);
  const code = `const { acquireLock } = require(process.argv[1]); acquireLock({local:process.argv[2]}); process.stdout.write('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code, require.resolve('../../../host/controller/operations'), paths.local], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  assert.throws(() => acquireLock(paths), { code: 'directory_operation_busy' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const fd = acquireLock(paths); fs.closeSync(fd);
});

test('interrupted storage resumes only its bound reservation and never follows storage symlinks', t => {
  const paths = fixture(t), journal = new DirectoryJournal(paths);
  const job = journal.request('create', 'storage_retry');
  const root = path.join(paths.dsps, job.dspId);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.provisioning'), JSON.stringify({ version: 1, id: job.dspId, creationId: job.creationId }), { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'config'), { mode: 0o700 });
  assert.throws(() => ensureDsp(paths, job.dspId, 'create_' + 'f'.repeat(32)));
  fs.symlinkSync(paths.local, path.join(root, 'data'));
  assert.throws(() => ensureDsp(paths, job.dspId, job.creationId));
  assert.deepEqual(fs.readdirSync(paths.local).sort(), ['state']);
  fs.unlinkSync(path.join(root, 'data'));
  assert.equal(ensureDsp(paths, job.dspId, job.creationId).creationId, job.creationId);
  assert.equal(ensureDsp(paths, job.dspId, job.creationId).id, job.dspId);
});

test('failed creation retains identity and credentials; completed replay has no host effects', async t => {
  const paths = fixture(t), m = manager(paths);
  const start = m.host.start;
  m.host.start = async () => { throw new Error('injected interruption'); };
  await assert.rejects(m.value.apply('create', 'create_retry'), { code: 'directory_operation_failed' });
  const [record] = m.value.journal.all();
  const token = fs.readFileSync(path.join(paths.dsps, record.id, 'secrets/runtime-agent/registration-token'));
  const next = manager(paths);
  next.host.start = start;
  next.value.hub = m.value.hub;
  const result = await next.value.apply('create', 'create_retry');
  assert.equal(result.dspId, record.id);
  assert.deepEqual(fs.readFileSync(path.join(paths.dsps, record.id, 'secrets/runtime-agent/registration-token')), token);
  assert.deepEqual(await next.value.apply('create', 'create_retry'), result);
  assert.equal(m.starts.length, 1);
  assert.equal(fs.readdirSync(paths.dsps).length, 1);
  await assert.rejects(next.value.apply('stop', 'create_retry', record.id), { code: 'directory_request_conflict' });
});

test('stop supersedes an older failed start and recovery preserves desired states and sibling data', async t => {
  const paths = fixture(t), m = manager(paths);
  const first = await m.value.apply('create', 'create_first');
  const second = await m.value.apply('create', 'create_second');
  const keep = path.join(paths.dsps, first.dspId, 'data/retained'); fs.writeFileSync(keep, 'synthetic');
  const start = m.host.start;
  m.host.start = async () => { throw new Error('injected interruption'); };
  await assert.rejects(m.value.apply('restart', 'failed_restart', first.dspId));
  await m.value.apply('stop', 'stop_after_failure', first.dspId);
  m.host.start = start;
  await assert.rejects(m.value.apply('restart', 'failed_restart', first.dspId), { code: 'directory_request_superseded' });
  await m.value.recover();
  assert.equal(m.active.has(first.dspId), false);
  assert.equal(m.active.has(second.dspId), true);
  await m.value.apply('start', 'resume_first', first.dspId);
  await m.value.apply('retire', 'retire_first', first.dspId);
  assert.equal(m.value.journal.authorityCatalog().resolve(first.dspId), null);
  assert.equal(m.active.has(second.dspId), true);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'synthetic');
  assert.equal(inspectDsp(paths, first.dspId).id, first.dspId);
  await assert.rejects(m.value.apply('start', 'restart_retired', first.dspId), { code: 'directory_dsp_retired' });
});

test('controller accepts only explicit lifecycle fields', () => {
  assert.equal(request('{"action":"list"}').action, 'list');
  for (const value of [{ action: 'create', requestId: 'request_key', command: '/bin/true' },
    { action: 'start', requestId: 'request_key' }, { action: 'remove', dspId: 'invalid' }, []]) {
    assert.throws(() => request(JSON.stringify(value)), { code: 'directory_request_invalid' });
  }
});
