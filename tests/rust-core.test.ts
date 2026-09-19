import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { capturedMail } from './mail-support.js';
import { fixture, until } from './rust-support.js';
import { employeeName } from '../shared/paycom.js';
const password = 'Dispatch-demo-2026!';
const credentials = {
  clientCode: 'TEST',
  username: 'private-user',
  password: 'synthetic-password',
  securityAnswers: ['00123', 'two', 'three', 'four', 'five'],
};

test('Rust bootstrap creates only the initial owner and empty Dev DSP; locks exclude another core and backup', async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  const owner = await f.client();
  assert.equal(owner.session.dsps.length, 1);
  await owner.select(owner.session.dsps[0].id);
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 0);
  assert.equal((await owner.get('/api/dsp/connections')).value.enabled, false);
  assert.equal((await owner.get('/api/dsp/jobs')).value.length, 0);
  assert.throws(() => f.cli(['serve']), /stop_services_before_operation/);
  assert.throws(() => f.cli(['backup', `${f.root}-backup`]), /stop_services_before_operation/);
  assert.equal(fs.readFileSync(`/proc/${f.pid()}/comm`, 'utf8').trim(), 'dispatch-backen');
  assert.equal(fs.readFileSync(`/proc/${f.pid()}/task/${f.pid()}/children`, 'utf8').trim(), '');
  await f.stop();
  assert.throws(
    () => f.cli(['bootstrap', 'again@dispatch.test', 'Again', 'Owner'], password),
    /bootstrap_requires_empty_platform/,
  );
});

test('Rust API enforces login, origin, host, CSRF, tenant views and membership permissions', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.request('/api/session')).status, 401);
  assert.equal(
    (
      await f.request(
        '/api/auth/login',
        { email: 'owner@dispatch.test', password },
        { origin: 'https://evil.test' },
      )
    ).status,
    403,
  );
  assert.equal((await f.request('/api/health', undefined, { host: 'evil.test' })).status, 400);
  assert.equal(
    (await f.request('/api/auth/login', { email: 'owner@dispatch.test', password, extra: true }))
      .status,
    400,
  );
  const owner = await f.client();
  const member = await f.client('member@dispatch.test');
  assert.equal(member.session.dsps.length, 1);
  assert.equal((await member.get('/api/platform/dsps')).status, 403);
  assert.equal((await member.get('/api/dsp/employees')).status, 403);
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await member.select(north.id);
  assert.equal((await member.get('/api/dsp/employees')).value.total, 12);
  assert.equal((await member.get('/api/dsp/connections')).status, 403);
  assert.equal((await member.post('/api/dsp/jobs', { requestId: 'forbidden' })).status, 403);
  assert.equal(
    (await f.request('/api/session/dsp', { dspId: north.id }, { cookie: owner.headers.cookie! }))
      .status,
    403,
  );
  const dev = owner.session.dsps.find((d: { permanent: boolean }) => d.permanent);
  assert.equal((await member.post('/api/session/dsp', { dspId: dev.id })).status, 403);
  await owner.select(north.id);
  owner.headers['x-dispatch-view'] += 'tampered';
  assert.equal((await owner.get('/api/dsp/employees')).status, 409);
  const diagnostics = await owner.get('/api/platform/diagnostics');
  assert(diagnostics.value.runtime.coreMemoryBytes > 0);
  assert.equal(diagnostics.value.runtime.workerMemoryBytes, 0);
});

test('a platform owner looks through any DSP role with exactly that role’s access, unseen by the DSP', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  const full = await owner.select(north.id);
  assert.equal(full.role.owner, true);
  const custom = await owner.post('/api/dsp/roles', {
    name: 'Auditor',
    permissions: ['audit.view'],
  });
  assert.equal(custom.status, 201, JSON.stringify(custom.value));
  const opened = await owner.select(north.id);
  assert.deepEqual(
    opened.roles.map((role: { name: string }) => role.name),
    ['Owner', 'Manager', 'Member', 'Auditor'],
  );
  const preview = async (roleId: string) => {
    const view = await owner.post('/api/session/dsp', { dspId: north.id, roleId });
    assert.equal(view.status, 200, JSON.stringify(view.value));
    owner.headers['x-dispatch-view'] = view.value.token;
    return view.value;
  };
  const auditor = await preview(custom.value.id);
  assert.deepEqual(auditor.role, { id: custom.value.id, name: 'Auditor', owner: false });
  assert.deepEqual(auditor.permissions, ['audit.view']);
  assert.equal(auditor.roles.length, 4);
  assert.equal((await owner.get('/api/dsp/employees')).status, 403);
  assert.equal((await owner.get('/api/dsp/roles')).status, 403);
  const log = await owner.get('/api/dsp/audit');
  assert.equal(log.status, 200);
  assert(!JSON.stringify(log.value).includes('owner_view_opened'));

  // The previewed role is part of the signed view and cannot be traded up.
  const manager = opened.roles.find((role: { name: string }) => role.name === 'Manager');
  const token = owner.headers['x-dispatch-view']!;
  owner.headers['x-dispatch-view'] = token.replace(custom.value.id, manager.id);
  assert.equal((await owner.get('/api/dsp/employees')).status, 409);
  owner.headers['x-dispatch-view'] = [token.split('.')[0], token.split('.')[2]].join('.');
  assert.equal((await owner.get('/api/dsp/employees')).status, 409);

  await preview(manager.id);
  assert.equal((await owner.get('/api/dsp/employees')).status, 200);
  assert.equal((await owner.get('/api/dsp/connections')).status, 403);

  // Deleting the previewed role expires the view, and it cannot be reopened.
  await owner.select(north.id);
  const stale = (await preview(custom.value.id)).token;
  await owner.select(north.id);
  assert.equal((await owner.post(`/api/dsp/roles/${custom.value.id}/remove`)).status, 200);
  owner.headers['x-dispatch-view'] = stale;
  assert.equal((await owner.get('/api/dsp/audit')).status, 409);
  assert.equal(
    (await owner.post('/api/session/dsp', { dspId: north.id, roleId: custom.value.id })).status,
    409,
  );

  const member = await f.client('member@dispatch.test');
  assert.equal(
    (await member.post('/api/session/dsp', { dspId: north.id, roleId: manager.id })).status,
    403,
  );
  assert.equal((await member.select(north.id)).roles, undefined);
});
test('Rust provisioning, invitation acceptance, profile setup, removal and restoration preserve boundaries', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const created = await owner.post('/api/platform/dsps', { ownerEmail: 'new@dispatch.test' });
  assert.equal(created.status, 201);
  const id = created.value.dsp.id;
  for (const area of ['config', 'data', 'secrets', 'state'])
    assert.equal(fs.statSync(path.join(f.root, 'dsps', id, area)).mode & 0o077, 0);
  assert.equal(created.value.invitationUrl, undefined);
  assert.deepEqual(created.value.invitation, { email: 'new@dispatch.test', status: 'queued' });
  const message = await capturedMail(f.root, 'new@dispatch.test');
  assert.match(message.subject, /^\[Dispatch Dev\]/);
  assert.match(message.html, />Start DSP onboarding<\/a>/);
  assert.match(message.text, / invited you to set up a new DSP on Dispatch as its owner\./);
  assert.equal(message.origin, f.env.DISPATCH_ORIGIN);
  const raw = /token=([A-Za-z0-9_-]{43})/.exec(message.text)![1];
  const invite = `/api/invitations/${raw}`;
  assert.equal((await f.request(invite)).value.email, 'new@dispatch.test');
  assert.equal(
    (await f.request(invite + '/accept', { firstName: 'New', lastName: 'Owner', password })).status,
    200,
  );
  assert.equal(
    (await f.request(invite + '/accept', { firstName: 'Replay', lastName: 'Owner', password }))
      .status,
    404,
  );
  const user = await f.client('new@dispatch.test');
  const view = await user.select(id);
  assert.equal(view.profile.setupRequired, true);
  assert.equal(
    (
      await user.post('/api/dsp/profile', {
        name: 'New Logistics',
        timezone: 'America/Chicago',
        abbreviation: 'NEW',
        stationCode: 'dtx1',
      })
    ).status,
    200,
  );
  assert.equal((await user.get('/api/dsp/employees')).status, 409);
  assert.equal((await user.select(id)).profile.stationCode, 'DTX1');
  const members = (await user.get('/api/dsp/members')).value;
  assert.equal((await user.post(`/api/dsp/members/${members[0].id}`, { role: null })).status, 409);
  assert.equal((await owner.post(`/api/platform/dsps/${id}/remove`)).status, 200);
  assert.equal((await user.get('/api/dsp/employees')).status, 409);
  assert.equal(
    (await owner.post(`/api/platform/dsps/${id}/status`, { status: 'active' })).status,
    409,
  );
  assert.equal((await owner.post(`/api/platform/dsps/${id}/restore`)).status, 200);
  await user.select(id);
  const dev = owner.session.dsps.find((d: { permanent: boolean }) => d.permanent);
  assert.equal((await owner.post(`/api/platform/dsps/${dev.id}/remove`)).status, 409);
  assert.equal(
    (await owner.post(`/api/platform/dsps/${dev.id}/status`, { status: 'suspended' })).status,
    409,
  );
});

test('Rust password recovery uses the private outbox, revokes sessions and consumes reset links once', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  assert.equal(
    (await f.request('/api/auth/forgot-password', { email: 'owner@dispatch.test' })).status,
    202,
  );
  const mail = path.join(f.root, 'data/platform/development-mail');
  const completed = () =>
    fs.existsSync(mail) ? fs.readdirSync(mail).filter((name) => name.endsWith('.json')) : [];
  await until(async () => completed().length > 0);
  const filename = path.join(mail, completed()[0]!);
  assert.equal(fs.statSync(filename).mode & 0o077, 0);
  const message = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.match(message.html, />Reset password<\/a>/);
  const raw = /token=([A-Za-z0-9_-]{43})/.exec(message.text)![1];
  assert.equal(
    (await f.request('/api/auth/reset-password', { token: raw, password: 'Replacement-password!' }))
      .status,
    200,
  );
  assert.equal((await owner.get('/api/session')).status, 401);
  assert.equal((await f.request('/api/auth/reset-password', { token: raw, password })).status, 400);
  const renewed = await f.client('owner@dispatch.test', 'Replacement-password!');
  assert.equal(
    (await renewed.post('/api/auth/password', { currentPassword: 'wrong', password })).status,
    403,
  );
  assert.equal(
    (
      await renewed.post('/api/auth/password', {
        currentPassword: 'Replacement-password!',
        password,
      })
    ).status,
    200,
  );
  assert.equal((await renewed.get('/api/session')).status, 401);
});

test('Rust owns verification, encrypted credentials, collection, idempotency and disabling schedules', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
  await owner.select(dsp.id);
  assert.equal(
    (
      await owner.post('/api/dsp/connections/paycom', {
        ...credentials,
        securityAnswers: ['1', '1', '3', '4', '5'],
      })
    ).status,
    400,
  );
  const saved = await owner.post('/api/dsp/connections/paycom', {
    ...credentials,
    password: 'require-verification',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.status, 'needs_verification');
  const vault = path.join(f.root, 'dsps', dsp.id, 'secrets/paycom.enc');
  assert(!fs.readFileSync(vault, 'utf8').includes('private-user'));
  assert.equal(fs.statSync(vault).mode & 0o077, 0);
  const job = await owner.post('/api/dsp/jobs', { requestId: 'one' });
  assert.equal(job.status, 202);
  assert.equal((await owner.post('/api/dsp/jobs', { requestId: 'one' })).value.id, job.value.id);
  await until(
    async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'waiting_verification',
  );
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/verify', { code: 'bad' })).status,
    409,
  );
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/verify', { code: '123456' })).status,
    200,
  );
  await until(async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'succeeded');
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 12);
  assert.equal(
    (await owner.post('/api/dsp/schedule', { enabled: true, localTime: '06:00' })).status,
    200,
  );
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/disable', { removeCredentials: true })).status,
    200,
  );
  assert.equal(fs.existsSync(vault), false);
  assert.equal((await owner.get('/api/dsp/schedule')).value.enabled, false);
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 12);
});

test('Rust cancellation and suspension prevent late publication; restart recovers interrupted collection', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/connections/paycom', {
    ...credentials,
    password: 'require-verification',
  });
  const first = await owner.post('/api/dsp/jobs', { requestId: 'cancel-me' });
  await until(
    async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'waiting_verification',
  );
  assert.equal(
    (await owner.post(`/api/dsp/jobs/${first.value.id}/cancel`)).value.status,
    'cancelled',
  );
  assert.equal((await owner.get('/api/dsp/employees')).value.total, 0);
  await owner.post('/api/dsp/jobs', { requestId: 'restart-me' });
  await until(
    async () => (await owner.get('/api/dsp/jobs')).value[0].status === 'waiting_verification',
  );
  await f.stop('SIGKILL');
  await f.start();
  owner = await f.client();
  await owner.select(dsp.id);
  await until(async () => {
    const row = (await owner.get('/api/dsp/jobs')).value[0];
    return row.status === 'waiting_verification' && row.attempt === 2;
  });
  await owner.post(`/api/platform/dsps/${dsp.id}/status`, { status: 'suspended' });
  const jobs = (await owner.get('/api/platform/jobs')).value;
  assert(
    jobs
      .filter((j: { dspId: string }) => j.dspId === dsp.id)
      .every((j: { status: string }) => j.status === 'cancelled'),
  );
});

test('Rust workforce settings enforce revisions, filter employees and timecards, and retain history', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(north.id);
  const before = (await owner.get('/api/dsp/paycom/settings')).value;
  const values = {
    ...before.values,
    name_order: 'last_first',
    department: 'Delivery',
    driver_departments: ['Delivery'],
    automatic_sync: false,
  };
  assert.equal(
    (await owner.post('/api/dsp/paycom/settings', { revision: before.revision, values })).status,
    200,
  );
  assert.equal(
    (await owner.post('/api/dsp/paycom/settings', { revision: before.revision, values })).status,
    409,
  );
  const employees = (await owner.get('/api/dsp/employees?limit=5')).value;
  assert.equal(employees.total, 11);
  assert.equal(employees.employees.length, 5);
  assert(employees.employees.every((e: { name: string }) => e.name.includes(', ')));
  const detail = (await owner.get('/api/dsp/employees/E002')).value;
  assert.equal(detail.employee.name, 'Ellis, Jordan');
  assert.equal(detail.timecards.length, 7);
  const date = detail.timecards[0].date;
  const daily = await owner.get(`/api/dsp/timecards?date=${date}&sort=totalHours&direction=desc`);
  assert.equal(daily.value.rows.length, 11);
  assert.equal((await owner.get('/api/dsp/timecards?date=2026-02-30')).status, 400);
  const member = await f.client('member@dispatch.test');
  await member.select(north.id);
  assert.deepEqual((await member.get('/api/dsp/paycom/settings')).value.history, []);
  assert.equal((await owner.get('/api/dsp/paycom/settings')).value.history.length, 1);
});

test('Rust backup and restore validate checksums, exclude runtime locks and revoke web capabilities', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const backup = `${f.root}-backup`,
    restored = `${f.root}-restored`;
  t.after(() => {
    fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(restored, { recursive: true, force: true });
  });
  await f.stop();
  f.cli(['backup', backup]);
  f.cli(['restore', backup, restored]);
  const db = new DatabaseSync(path.join(restored, 'data/platform/accounts.sqlite'));
  assert.equal((db.prepare('SELECT count(*) n FROM sessions').get() as { n: number }).n, 0);
  db.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'backup.json'), 'utf8'));
  assert(!manifest.files.some((file: { path: string }) => file.path.endsWith('.lock')));
  const providerFiles = manifest.files.filter((file: { path: string }) =>
    file.path.endsWith('/data/paycom/paycom.sqlite'),
  );
  assert.equal(providerFiles.length, 3);
  for (const file of providerFiles) {
    const provider = new DatabaseSync(path.join(restored, file.path), { readOnly: true });
    assert.equal(provider.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(
      provider.prepare('SELECT provider FROM storage_identity').get()!.provider,
      'paycom',
    );
    provider.close();
  }

  fs.appendFileSync(path.join(backup, manifest.files[0].path), 'tampered');
  fs.rmSync(restored, { recursive: true });
  assert.throws(() => f.cli(['restore', backup, restored]), /backup_checksum_failed/);
  assert.equal(fs.existsSync(restored), false);
  await f.start();
  assert.equal((await owner.get('/api/session')).status, 200);
});

test('cancelling a queued job preserves the active verification session and does not consume another attempt', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/connections/paycom', {
    ...credentials,
    password: 'require-verification',
  });
  const first = (await owner.post('/api/dsp/jobs', { requestId: 'active' })).value;
  await until(async () =>
    (await owner.get('/api/dsp/jobs')).value.some(
      (j: { id: string; status: string }) =>
        j.id === first.id && j.status === 'waiting_verification',
    ),
  );
  const second = (await owner.post('/api/dsp/jobs', { requestId: 'queued' })).value;
  assert.equal((await owner.post(`/api/dsp/jobs/${second.id}/cancel`)).value.status, 'cancelled');
  assert.equal((await owner.get('/api/dsp/connections')).value.status, 'needs_verification');
  assert.equal(
    (await owner.post('/api/dsp/connections/paycom/verify', { code: '123456' })).status,
    200,
  );
  await until(async () =>
    (await owner.get('/api/dsp/jobs')).value.some(
      (j: { id: string; status: string }) => j.id === first.id && j.status === 'succeeded',
    ),
  );
  const cancelled = (await owner.get('/api/dsp/jobs')).value.find(
    (j: { id: string }) => j.id === second.id,
  );
  assert.equal(cancelled.attempt, 0);
  assert.equal(cancelled.status, 'cancelled');
});

test('independent platforms reject each other’s sessions and signed views', async (t) => {
  const a = await fixture(false);
  t.after(a.close);
  const b = await fixture(false);
  t.after(b.close);
  const one = await a.client(),
    two = await b.client();
  await one.select(one.session.dsps[0].id);
  await two.select(two.session.dsps[0].id);
  assert.equal((await b.request('/api/session', undefined, one.headers)).status, 401);
  two.headers['x-dispatch-view'] = one.headers['x-dispatch-view']!;
  assert.equal((await two.get('/api/dsp/employees')).status, 404);
});

test('Unicode employee sorting agrees with the dashboard locale and preserves display-name behavior', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.stop();
  const names = [
    'zoë Z',
    'Álvaro Q',
    'alice A',
    'Alice A',
    'Émile É',
    'Émile É',
    '张 伟',
    ' Östen Y',
    'Mia   Z ',
  ];
  const dsp = f.database(
    'data/platform/accounts.sqlite',
    (db) =>
      db.prepare("SELECT id FROM dsps WHERE name='Northline Logistics'").get() as { id: string },
  );
  f.collector(dsp.id, (db) => {
    db.exec('DELETE FROM timecards; DELETE FROM employees');
    const publication = db.prepare('SELECT id FROM publications WHERE active=1').get() as {
      id: string;
    };
    names.forEach((name, i) =>
      db
        .prepare('INSERT INTO employees VALUES (?,?,?,?,?,?,?)')
        .run(publication.id, `E${i}`, name, 'Delivery', 'Driver', '', 1),
    );
  });
  await f.start();
  const owner = await f.client();
  await owner.select(dsp.id);
  const normalize = (s: string) => employeeName(s, 'first_last');
  const expected = names
    .map((name, i) => ({ name: normalize(name), code: `E${i}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.code.localeCompare(b.code, 'en'));
  const result = (await owner.get('/api/dsp/employees')).value.employees as {
    name: string;
    code: string;
  }[];
  assert.deepEqual(
    result.map(({ name, code }) => ({ name, code })),
    expected,
  );
});

test('existing-account invitations require the account password and revocation respects tenant ownership', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const member = await f.client('member@dispatch.test');
  const dev = owner.session.dsps.find((d: { permanent: boolean }) => d.permanent);
  await owner.select(dev.id);
  const roles: { id: string; name: string }[] = (await owner.get('/api/dsp/roles')).value;
  const roleId = (name: string) => roles.find((role) => role.name === name)!.id;
  const invited = await owner.post('/api/dsp/members/invite', {
    email: 'member@dispatch.test',
    role: roleId('Manager'),
  });
  assert.equal(invited.status, 200);
  assert.equal(invited.value.invitationUrl, undefined);
  const token = /token=([A-Za-z0-9_-]{43})/.exec(
    (await capturedMail(f.root, 'member@dispatch.test')).text,
  )![1];
  assert.equal(
    (
      await f.request(`/api/invitations/${token}/accept`, {
        firstName: 'Fake',
        lastName: 'Owner',
        password: 'wrong-password-long',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(`/api/invitations/${token}/accept`, {
        firstName: 'Fake',
        lastName: 'Owner',
        password,
      })
    ).status,
    200,
  );
  const existing = await f.client('member@dispatch.test');
  assert.equal(existing.session.user.firstName, 'Jordan');
  await existing.select(dev.id);
  assert.equal(
    (await existing.post('/api/dsp/invitations/revoke', { email: 'new@dispatch.test' })).status,
    403,
  );
  const pending = await owner.post('/api/dsp/members/invite', {
    email: 'new@dispatch.test',
    role: roleId('Member'),
  });
  assert.equal(pending.value.invitationUrl, undefined);
  const raw = /token=([A-Za-z0-9_-]{43})/.exec(
    (await capturedMail(f.root, 'new@dispatch.test')).text,
  )![1];
  assert.equal(
    (await member.post('/api/dsp/invitations/revoke', { email: 'new@dispatch.test' })).status,
    403,
  );
  assert.equal(
    (await owner.post('/api/dsp/invitations/revoke', { email: 'new@dispatch.test' })).status,
    200,
  );
  assert.equal((await f.request(`/api/invitations/${raw}`)).status, 404);
});

test('SQLite write contention leaves health responsive and the pending write recovers after unlock', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const db = new DatabaseSync(path.join(f.root, 'data/platform/accounts.sqlite'));
  let pending: Promise<unknown> | undefined;
  try {
    db.exec('BEGIN IMMEDIATE');
    pending = owner.post('/api/platform/dsps', { ownerEmail: 'blocked@dispatch.test' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    assert.equal((await f.request('/api/health')).status, 200);
    assert(Date.now() - started < 500);
    db.exec('ROLLBACK');
    assert.equal(((await pending) as { status: number }).status, 201);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    await pending;
  }
});
