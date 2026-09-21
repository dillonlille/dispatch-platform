import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../support/support.js';

type Role = { id: string; name: string; owner: boolean; permissions: string[]; members: number };

test('custom roles gate tenant APIs and never grant more than the actor holds', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const member = await f.client('member@dispatch.test');
  const north = member.session.dsps[0];
  assert.equal(north.role, 'Member');
  await owner.select(north.id);
  const roles = async (): Promise<Role[]> => (await owner.get('/api/dsp/roles')).value;
  const named = async (name: string) => (await roles()).find((role) => role.name === name)!;
  assert.deepEqual(
    (await roles()).map((role) => [role.name, role.owner, role.permissions.length]),
    [
      ['Owner', true, 8],
      ['Manager', false, 2],
      ['Member', false, 1],
    ],
  );

  let view = await member.select(north.id);
  assert.deepEqual(view.permissions, ['timecard.view']);
  assert.deepEqual(view.role, { id: (await named('Member')).id, name: 'Member', owner: false });
  assert.equal((await member.get('/api/dsp/employees')).status, 200);
  for (const url of ['/api/dsp/jobs', '/api/dsp/roles', '/api/dsp/members'])
    assert.equal((await member.get(url)).status, 403, url);

  for (const [body, status] of [
    [{ name: 'Owner', permissions: [] }, 400],
    [{ name: 'Manager', permissions: [] }, 409],
    [{ name: 'Lead', permissions: ['everything'] }, 400],
    [{ name: 'Auditor', permissions: ['audit.view'] }, 400],
  ] as const)
    assert.equal((await owner.post('/api/dsp/roles', body)).status, status);
  const created = await owner.post('/api/dsp/roles', {
    name: 'Team Lead',
    permissions: ['timecard.manage', 'members.invite', 'members.manage', 'roles.manage'],
  });
  assert.equal(created.status, 201);
  const lead: Role = created.value;
  // Managing the timecard always includes viewing it.
  assert.deepEqual(lead.permissions, [
    'timecard.view',
    'timecard.manage',
    'members.invite',
    'members.manage',
    'roles.manage',
  ]);

  const membership = (await owner.get('/api/dsp/members')).value.find(
    (row: { email: string }) => row.email === 'member@dispatch.test',
  );
  assert.equal(
    (await owner.post(`/api/dsp/members/${membership.id}`, { role: lead.id })).status,
    200,
  );
  // Role changes expire every open view of the DSP.
  assert.equal((await member.get('/api/dsp/employees')).value.error, 'dsp_view_expired');
  view = await member.select(north.id);
  assert.deepEqual(view.permissions, lead.permissions);
  assert.equal((await member.get('/api/dsp/schedules')).status, 200);
  assert.equal((await member.get('/api/dsp/connections')).status, 403);
  assert.equal((await member.post('/api/dsp/jobs', { requestId: 'denied' })).status, 403);

  await owner.select(north.id);
  const ownerRole = await named('Owner');
  const manager = await named('Manager');
  const denied = async (url: string, body: unknown) => {
    const result = await member.post(url, body);
    assert.equal(result.status, 403, url);
    assert.equal(result.value.error, 'role_exceeds_permissions');
  };
  await denied('/api/dsp/roles', { name: 'Sneaky', permissions: ['connections.manage'] });
  await denied(`/api/dsp/roles/${manager.id}`, { name: 'Manager', permissions: [] });
  await denied(`/api/dsp/roles/${manager.id}/remove`, {});
  await denied(`/api/dsp/members/${membership.id}`, { role: ownerRole.id });
  await denied(`/api/dsp/members/${membership.id}`, { role: manager.id });
  await denied('/api/dsp/members/invite', { email: 'x@dispatch.test', role: ownerRole.id });
  const viewer = await member.post('/api/dsp/roles', { name: 'Viewer', permissions: [] });
  assert.equal(viewer.status, 201);

  assert.equal(
    (await owner.post(`/api/dsp/roles/${ownerRole.id}`, { name: 'Boss', permissions: [] })).value
      .error,
    'owner_role_locked',
  );
  assert.equal(
    (await owner.post(`/api/dsp/roles/${lead.id}/remove`, {})).value.error,
    'role_in_use',
  );

  // Editing a role reaches its members as soon as they reopen the DSP.
  assert.equal(
    (await owner.post(`/api/dsp/roles/${lead.id}`, { name: 'Team Lead', permissions: [] })).status,
    200,
  );
  view = await member.select(north.id);
  assert.deepEqual(view.permissions, []);
  assert.equal(
    (await member.post('/api/dsp/presence', { tab: 'roles', state: 'active' })).status,
    200,
  );
  assert.equal((await member.get('/api/dsp/employees')).status, 403);
  assert.equal((await member.get('/api/dsp/roles')).status, 403);

  await owner.select(north.id);
  assert.equal(
    (await owner.post(`/api/dsp/members/${membership.id}`, { role: viewer.value.id })).status,
    200,
  );
  await owner.select(north.id);
  assert.equal((await owner.post(`/api/dsp/roles/${lead.id}/remove`, {})).status, 200);
  assert.equal((await named('Viewer')).members, 1);
});

test('memberships written without a role id resolve through the legacy role after restart', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const north = (await f.client('member@dispatch.test')).session.dsps[0];
  await f.stop();
  f.database('data/platform/accounts.sqlite', (db) => {
    db.exec('UPDATE memberships SET role_id=NULL');
    db.exec("DELETE FROM roles WHERE name='Member'");
  });
  await f.start();
  const member = await f.client('member@dispatch.test');
  assert.deepEqual((await member.select(north.id)).permissions, ['timecard.view']);
  const rows = f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare(
        'SELECT m.role,r.name FROM memberships m JOIN roles r ON r.id=m.role_id AND r.dsp_id=m.dsp_id',
      )
      .all(),
  );
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [{ role: 'member', name: 'Member' }],
  );
});

test('members report presence to their team; platform owners never appear', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const member = await f.client('member@dispatch.test');
  const north = member.session.dsps[0];
  // A platform owner can also hold a real membership in a DSP they look after.
  f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare(
        "INSERT INTO memberships(id,user_id,dsp_id,role,role_id) SELECT 'mem_platform_owner',?,dsp_id,'owner',id FROM roles WHERE dsp_id=? AND system=1",
      )
      .run(owner.session.user.id, north.id),
  );
  await owner.select(north.id);
  await member.select(north.id);
  const statuses = async () =>
    Object.fromEntries(
      (await owner.get('/api/dsp/members')).value.map((row: { email: string; status: string }) => [
        row.email,
        row.status,
      ]),
    );
  const everyoneOffline = { 'owner@dispatch.test': 'offline', 'member@dispatch.test': 'offline' };
  assert.deepEqual(await statuses(), everyoneOffline);

  const beat = (tab: string, state: string) => member.post('/api/dsp/presence', { tab, state });
  assert.equal((await beat('one', 'idle')).status, 200);
  assert.equal((await statuses())['member@dispatch.test'], 'idle');
  // The most active of a member's open dashboards wins.
  assert.equal((await beat('two', 'active')).status, 200);
  assert.equal((await statuses())['member@dispatch.test'], 'active');
  await beat('two', 'gone');
  assert.equal((await statuses())['member@dispatch.test'], 'idle');
  await beat('one', 'gone');

  assert.equal(
    (await owner.post('/api/dsp/presence', { tab: 'one', state: 'active' })).status,
    200,
  );
  assert.deepEqual(await statuses(), everyoneOffline);

  assert.equal((await beat('one', 'busy')).status, 400);
  const { 'x-dispatch-view': _view, ...unscoped } = member.headers;
  assert.notEqual(
    (await f.request('/api/dsp/presence', { tab: 'one', state: 'active' }, unscoped)).status,
    200,
  );
});
