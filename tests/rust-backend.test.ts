import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fixture, until } from './helpers.js';
import { fixtureWorkforce } from '../integrations/paycom/fixture.js';
import { paycomDefaults } from '../shared/paycom.js';
import { RustBackend } from '../services/rust.js';
import { configuration } from '../services/config.js';

test('Rust employee responses match the existing implementation across publications, names and tenants', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const client = await f.client();
  const dsps = client.session.dsps.filter((dsp) => dsp.environment === 'production');
  for (const dsp of dsps) {
    await client.select(dsp.id);
    assert.equal((await client.get('/api/dsp/employees/unknown')).statusCode, 404);
    const old = fixtureWorkforce(dsp);
    old.collectedAt = '2026-01-01T00:00:00.000Z';
    old.employees[0]!.name = `  Ana\uFEFFMaría\u00A0${dsp.name}  `;
    old.employees[1]!.active = false;
    f.runtime.runner.workforce.publish(dsp.id, old);
    const next = structuredClone(old);
    next.collectedAt = '2026-01-02T00:00:00.000Z';
    const historicalCode = next.employees.pop()!.code;
    next.timecards = next.timecards.filter((card) => card.employeeCode !== historicalCode);
    next.employees[0]!.position = 'Latest position';
    f.runtime.runner.workforce.publish(dsp.id, next);
    for (const name_order of ['first_last', 'last_first']) {
      f.runtime.storage.dsp(dsp.id, (db) =>
        db.run(
          "INSERT OR REPLACE INTO settings(key,value) VALUES ('paycom.preferences',?)",
          JSON.stringify({ revision: 1, values: { ...paycomDefaults, name_order }, history: [] }),
        ),
      );
      for (const employee of old.employees) {
        const response = await client.get(`/api/dsp/employees/${employee.code}`);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(
          response.json(),
          f.runtime.runner.workforce.employee(dsp.id, employee.code),
        );
      }
    }
  }
});

test('Rust reads retain login, signed DSP views, input validation and permission revalidation', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const member = await f.client('member@dispatch.test');
  const dsp = member.session.dsps[0]!;
  const workforce = fixtureWorkforce(dsp);
  const code = workforce.employees[0]!.code;
  f.runtime.runner.workforce.publish(dsp.id, workforce);
  const route = `/api/dsp/employees/${code}`;
  assert.equal(
    (await f.app.inject({ url: route, headers: { host: '127.0.0.1:5173' } })).statusCode,
    401,
  );
  assert.equal((await member.get(route)).statusCode, 403);
  await member.select(dsp.id);
  assert.equal((await member.get('/api/dsp/employees/invalid!')).statusCode, 400);
  assert.equal((await member.get(route)).statusCode, 200);
  const read = f.runtime.rust.employee.bind(f.runtime.rust);
  f.runtime.rust.employee = async (...args) => {
    const result = await read(...args);
    f.runtime.storage.platform.run(
      'DELETE FROM memberships WHERE user_id=? AND dsp_id=?',
      member.session.user.id,
      dsp.id,
    );
    return result;
  };
  assert.equal((await member.get(route)).statusCode, 403);
});

test('Rust refuses symlinked storage and incompatible schemas without changing data', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const client = await f.client();
  const [a, b] = client.session.dsps.filter((dsp) => dsp.environment === 'production');
  assert(a && b);
  const data = fixtureWorkforce(a);
  f.runtime.runner.workforce.publish(a.id, data);
  const file = path.join(f.runtime.storage.paths.dspArea(a.id, 'data'), 'dispatch.sqlite');
  const before = fs.readFileSync(file);
  await f.runtime.rust.employee(a.id, data.employees[0]!.code);
  assert.deepEqual(fs.readFileSync(file), before);
  f.runtime.storage.dsp(a.id, (db) => db.run('PRAGMA user_version=2'));
  await assert.rejects(f.runtime.rust.employee(a.id, data.employees[0]!.code), {
    code: 'operation_failed',
  });
  const directory = path.dirname(file);
  fs.renameSync(directory, `${directory}-original`);
  fs.symlinkSync(f.runtime.storage.paths.dspArea(b.id, 'data'), directory);
  await assert.rejects(f.runtime.rust.employee(a.id, data.employees[0]!.code), {
    code: 'operation_failed',
  });
  await assert.rejects(f.runtime.rust.employee('../outside', 'A1'));
});

test('Rust crash recovery, private socket permissions and shutdown leave no child behind', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const pid = f.runtime.rust.pid!;
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const socket = command[1]!;
  assert.equal(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  process.kill(pid, 'SIGKILL');
  await until(() => !f.runtime.rust.pid);
  assert.equal(
    (await f.app.inject({ url: '/api/health', headers: { host: '127.0.0.1:5173' } })).statusCode,
    503,
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await f.runtime.rust.healthy();
  const replacement = f.runtime.rust.pid!;
  assert.notEqual(replacement, pid);
  await f.close();
  assert.throws(() => process.kill(replacement, 0), { code: 'ESRCH' });
  assert(!fs.existsSync(path.dirname(socket)));
});

test('missing Rust executable fails readiness and cleans up', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rust-missing-'));
  const backend = new RustBackend(
    configuration({ stateRoot: root, rustBackendPath: path.join(root, 'missing') }),
  );
  t.after(async () => {
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(backend.healthy(), { code: 'rust_backend_unavailable' });
});

test('SQLite contention in Rust leaves health requests responsive and reads recover after unlock', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const client = await f.client();
  const dsp = client.session.dsps.find((item) => item.environment === 'production')!;
  const workforce = fixtureWorkforce(dsp);
  f.runtime.runner.workforce.publish(dsp.id, workforce);
  const db = new DatabaseSync(
    path.join(f.runtime.storage.paths.dspArea(dsp.id, 'data'), 'dispatch.sqlite'),
  );
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
  let settled = false;
  const pending = f.runtime.rust.employee(dsp.id, workforce.employees[0]!.code).finally(() => {
    settled = true;
  });
  // Attach a handler immediately so a test failure cannot leave an unhandled rejection.
  const result = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await f.runtime.rust.healthy();
    assert.equal(settled, false, 'database read must still be waiting for the exclusive lock');
  } finally {
    db.exec('ROLLBACK;');
  }
  const response = await result;
  assert('value' in response);
  assert.equal(response.value.employee.code, workforce.employees[0]!.code);
});

test('Rust exits when the gateway input pipe disappears', { timeout: 10000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rust-orphan-'));
  fs.mkdirSync(path.join(directory, 'dsps'), { mode: 0o700 });
  const child = spawn(
    path.resolve('target/debug/dispatch-backend'),
    [path.join(directory, 'backend.sock'), path.join(directory, 'dsps')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
});
