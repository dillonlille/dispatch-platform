import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capturedMail } from './mail-support.js';
import { demo, fixture } from './support.js';
const { password } = demo;

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
