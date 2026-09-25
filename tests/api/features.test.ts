import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../support/support.js';

type Role = { id: string; name: string; permissions: string[] };
const all = ['timecard', 'uniforms', 'paycom', 'cortex'];

test('a feature switched off for a DSP stops existing there until it is switched back on', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const platform = await f.client();
  const member = await f.client('member@dispatch.test');
  const north = member.session.dsps[0];
  assert.deepEqual(north.features, all);
  let view = await member.select(north.id);
  assert.deepEqual(view.features, all);
  assert.deepEqual(view.permissions, ['uniforms.view', 'timecard.view']);
  assert.equal((await member.get('/api/dsp/uniforms')).status, 200);

  const url = `/api/platform/dsps/${north.id}/features`;
  assert.equal((await member.post(url, { feature: 'uniforms', enabled: false })).status, 403);
  assert.equal((await platform.post(url, { feature: 'nothing', enabled: false })).status, 404);
  assert.equal((await platform.post(url, { feature: 'uniforms' })).status, 400);
  let result = await platform.post(url, { feature: 'uniforms', enabled: false });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, {
    features: ['timecard', 'paycom', 'cortex'],
    changed: [{ feature: 'uniforms', enabled: false }],
  });
  // Every open view of the DSP expires; reopened, it has no uniform inventory.
  assert.equal((await member.get('/api/dsp/uniforms')).value.error, 'dsp_view_expired');
  view = await member.select(north.id);
  assert.deepEqual(view.features, ['timecard', 'paycom', 'cortex']);
  assert.deepEqual(view.permissions, ['timecard.view']);
  assert.equal((await member.get('/api/dsp/uniforms')).status, 403);
  // Owners hold every permission, but only of the features the DSP has.
  const owner = await platform.select(north.id);
  assert.deepEqual(owner.features, ['timecard', 'paycom', 'cortex']);
  assert.ok(!owner.permissions.includes('uniforms.view'));
  assert.equal((await platform.get('/api/dsp/uniforms')).status, 403);
  const listed = (await platform.get('/api/platform/dsps')).value.find(
    (dsp: { id: string }) => dsp.id === north.id,
  );
  assert.deepEqual(listed.features, ['timecard', 'paycom', 'cortex']);

  // A role keeps the grant it cannot show, through a save from the role sheet too.
  const roles: Role[] = (await platform.get('/api/dsp/roles')).value;
  const memberRole = roles.find((role) => role.name === 'Member')!;
  assert.deepEqual(memberRole.permissions, ['uniforms.view', 'timecard.view']);
  const saved = await platform.post(`/api/dsp/roles/${memberRole.id}`, {
    name: 'Member',
    permissions: ['timecard.manage'],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.permissions, ['uniforms.view', 'timecard.view', 'timecard.manage']);

  // Switching it back on restores everything as it was.
  result = await platform.post(url, { feature: 'uniforms', enabled: true });
  assert.deepEqual(result.value.changed, [{ feature: 'uniforms', enabled: true }]);
  view = await member.select(north.id);
  assert.deepEqual(view.permissions, ['uniforms.view', 'timecard.view', 'timecard.manage']);
  assert.equal((await member.get('/api/dsp/uniforms')).status, 200);
  result = await platform.post(url, { feature: 'uniforms', enabled: true });
  assert.deepEqual(result.value.changed, []);

  // A connection is its own feature; a page requiring what it provides goes with it.
  result = await platform.post(url, { feature: 'cortex', enabled: false });
  assert.deepEqual(result.value, {
    features: ['uniforms', 'paycom'],
    changed: [
      { feature: 'cortex', enabled: false },
      { feature: 'timecard', enabled: false },
    ],
  });
  view = await member.select(north.id);
  assert.deepEqual(view.permissions, ['uniforms.view']);
  assert.equal((await member.get('/api/dsp/employees')).status, 403);
  await platform.select(north.id);
  assert.equal((await platform.get('/api/dsp/connections/cortex')).status, 404);
  assert.equal((await platform.get('/api/dsp/connections/paycom')).status, 200);
  assert.equal((await platform.get('/api/dsp/schedules')).status, 403);
  // Enabling the page enables what it requires.
  result = await platform.post(url, { feature: 'timecard', enabled: true });
  assert.deepEqual(result.value, {
    features: all,
    changed: [
      { feature: 'cortex', enabled: true },
      { feature: 'timecard', enabled: true },
    ],
  });
  await platform.select(north.id);
  assert.equal((await platform.get('/api/dsp/connections/cortex')).status, 200);
  // Without any connection, nobody manages connections: the permission is gone too.
  await platform.post(url, { feature: 'paycom', enabled: false });
  result = await platform.post(url, { feature: 'cortex', enabled: false });
  assert.deepEqual(result.value.features, ['uniforms']);
  const alone = await platform.select(north.id);
  assert.ok(!alone.permissions.includes('connections.manage'));
  assert.equal((await platform.get('/api/dsp/connections')).status, 403);

  // Each switch is the platform's own record, never the DSP's.
  const events = (await platform.get('/api/platform/audit?limit=20')).value.events;
  const switches = events
    .filter((event: { action: string }) => event.action.startsWith('dsp.feature_'))
    .map((event: { action: string; detail: string }) => [event.action, event.detail]);
  // The last switch and its cascade were written in the same instant.
  assert.deepEqual(switches.slice(0, 3).sort(), [
    ['dsp.feature_disabled', 'cortex'],
    ['dsp.feature_disabled', 'paycom'],
    ['dsp.feature_disabled', 'timecard'],
  ]);
  // The timecard last went with Paycom; a cascade names what took it.
  const cascade = events.find(
    (event: { action: string; detail: string }) =>
      event.action === 'dsp.feature_disabled' && event.detail === 'timecard',
  );
  assert.deepEqual(cascade.changes, [{ field: 'cause', from: null, to: 'Paycom' }]);
});
