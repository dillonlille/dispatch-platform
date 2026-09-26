import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { demo, fixture, until } from '../support/support.js';
const { password } = demo;

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

test('a platform owner looks through any DSP role with exactly that role’s access', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  const full = await owner.select(north.id);
  assert.equal(full.role.owner, true);
  const custom = await owner.post('/api/dsp/roles', {
    name: 'Connections admin',
    permissions: ['connections.manage'],
  });
  assert.equal(custom.status, 201, JSON.stringify(custom.value));
  const opened = await owner.select(north.id);
  assert.deepEqual(
    opened.roles.map((role: { name: string }) => role.name),
    ['Owner', 'Manager', 'Member', 'Connections admin'],
  );
  const preview = async (roleId: string) => {
    const view = await owner.post('/api/session/dsp', { dspId: north.id, roleId });
    assert.equal(view.status, 200, JSON.stringify(view.value));
    owner.headers['x-dispatch-view'] = view.value.token;
    return view.value;
  };
  const connectionsAdmin = await preview(custom.value.id);
  assert.deepEqual(connectionsAdmin.role, {
    id: custom.value.id,
    name: 'Connections admin',
    owner: false,
  });
  assert.deepEqual(connectionsAdmin.permissions, ['connections.manage']);
  assert.equal(connectionsAdmin.roles.length, 4);
  assert.equal((await owner.get('/api/dsp/employees')).status, 403);
  assert.equal((await owner.get('/api/dsp/roles')).status, 403);
  assert.equal((await owner.get('/api/dsp/connections')).status, 200);

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
  assert.equal((await owner.get('/api/dsp/connections')).status, 409);
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

test('Rust password recovery uses the private outbox, revokes sessions and consumes reset links once', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare('INSERT INTO passkeys VALUES (?,?,?,?,?)')
      .run('legacy-owner', owner.session.user.id, '{}', 'Old key', 0),
  );
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
  assert.equal((await renewed.get('/api/platform/dsps')).status, 200);
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

test('password recovery gives existing and absent accounts the same delayed public answer', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const answers: { status: number; value: unknown; elapsed: number }[] = [];
  for (const email of ['owner@dispatch.test', 'absent@dispatch.test']) {
    const started = performance.now();
    const answer = await f.request('/api/auth/forgot-password', { email });
    answers.push({
      status: answer.status,
      value: answer.value,
      elapsed: performance.now() - started,
    });
  }
  for (const answer of answers) {
    assert.equal(answer.status, 202);
    assert.deepEqual(answer.value, { ok: true });
    assert(answer.elapsed >= 280, `recovery response returned in ${answer.elapsed}ms`);
  }
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

test('only platform owners can read and export audit events, even with old DSP audit grants', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const member = await f.client('member@dispatch.test');
  const north = member.session.dsps[0];
  await owner.select(north.id);

  // An existing custom role may still have the retired permission in storage.
  f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare("UPDATE roles SET permissions=? WHERE dsp_id=? AND name='Member'")
      .run(JSON.stringify(['timecard.view', 'audit.view']), north.id),
  );
  const view = await member.select(north.id);
  assert.deepEqual(view.permissions, ['timecard.view']);
  const denied = async () => {
    assert.equal((await member.get('/api/dsp/audit')).status, 404);
    assert.equal((await member.post('/api/dsp/audit/export', {})).status, 404);
    assert.equal((await member.get('/api/platform/audit')).status, 403);
    assert.equal((await member.post('/api/platform/audit/export', {})).status, 403);
  };
  await denied();

  // Owning a DSP still does not grant platform access.
  const roles = (await owner.get('/api/dsp/roles')).value;
  const dspOwner = roles.find((role: { owner: boolean }) => role.owner);
  const membership = (await owner.get('/api/dsp/members')).value.find(
    (row: { email: string }) => row.email === 'member@dispatch.test',
  );
  assert.equal(
    (await owner.post(`/api/dsp/members/${membership.id}`, { role: dspOwner.id })).status,
    200,
  );
  const ownerView = await member.select(north.id);
  assert.equal(ownerView.role.owner, true);
  assert(!ownerView.permissions.includes('audit.view'));
  await denied();

  // Even platform owners use the platform endpoints instead of a DSP log.
  await owner.select(north.id);
  assert.equal((await owner.get('/api/dsp/audit')).status, 404);
  assert.equal((await owner.post('/api/dsp/audit/export', {})).status, 404);
  const log = await owner.get(`/api/platform/audit?dsp=${north.id}`);
  assert.equal(log.status, 200);
  assert(
    log.value.events.some((event: { action: string }) => event.action === 'member.role_changed'),
  );
  assert(
    log.value.events.some((event: { action: string }) => event.action === 'dsp.owner_view_opened'),
  );
  assert(log.value.events.every((event: { dspId: string }) => event.dspId === north.id));
  assert.equal((await owner.get('/api/platform/audit?area=nowhere')).status, 400);
  const exported = await owner.post('/api/platform/audit/export', { dsp: north.id });
  assert.equal(exported.status, 200);
  assert(exported.value.events.length > 0);
  assert(exported.value.events.every((event: { dspId: string }) => event.dspId === north.id));
  const after = await owner.get('/api/platform/audit');
  assert(after.value.events.some((event: { action: string }) => event.action === 'audit.exported'));
});
