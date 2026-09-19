import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { demo, fixture, until } from './support.js';
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
  assert(Array.isArray(log.value.events) && typeof log.value.total === 'number');
  assert.equal((await owner.get('/api/dsp/audit?area=nowhere')).status, 400);

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
