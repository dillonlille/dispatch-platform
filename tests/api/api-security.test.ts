import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { demo, fixture } from '../support/support.js';
import { capturedMail } from '../support/mail-support.js';

test('removal revokes legacy inbound and authored invitations without transferring attribution', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const member = await f.client('member@dispatch.test');
  const dsp = member.session.dsps[0].id;
  await owner.select(dsp);
  const members = (await owner.get('/api/dsp/members')).value;
  const person = members.find((m: { email: string }) => m.email === 'member@dispatch.test');
  const tokens = ['a'.repeat(43), 'b'.repeat(43)];
  f.database('data/platform/accounts.sqlite', (db) => {
    const insert = db.prepare(
      "INSERT INTO invitations(hash,dsp_id,email,role,role_id,expires_at,created_by) VALUES (?,?,?,'member',?,?,?)",
    );
    insert.run(
      createHash('sha256').update(tokens[0]!).digest('hex'),
      dsp,
      person.email,
      person.roleId,
      Date.now() + 60000,
      owner.session.user.id,
    );
    insert.run(
      createHash('sha256').update(tokens[1]!).digest('hex'),
      dsp,
      'colleague@dispatch.test',
      person.roleId,
      Date.now() + 60000,
      person.userId,
    );
  });
  assert.equal(
    (await owner.post('/api/dsp/members/invite', { email: person.email, role: person.roleId }))
      .status,
    409,
  );
  assert.equal((await owner.post(`/api/dsp/members/${person.id}`, { role: null })).status, 200);
  assert.equal((await member.get('/api/session')).status, 401);
  for (const token of tokens) {
    assert.equal((await f.request(`/api/invitations/${token}`)).status, 404);
    assert.equal(
      (
        await f.request(`/api/invitations/${token}/accept`, {
          firstName: 'Removed',
          lastName: 'Member',
          password: demo.password,
        })
      ).status,
      404,
    );
  }
});

test('invitation password checks share login limits; duplicates cool down and replace prior grants', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const member = await f.client('member@dispatch.test');
  const dsp = owner.session.dsps.find(
    (d: { id: string }) => !member.session.dsps.some((m: { id: string }) => m.id === d.id),
  );
  await owner.select(dsp.id);
  const roles = (await owner.get('/api/dsp/roles')).value;
  const body = {
    email: 'member@dispatch.test',
    role: roles.find((r: { name: string }) => r.name === 'Member').id,
  };
  assert.equal((await owner.post('/api/dsp/members/invite', body)).status, 200);
  assert.equal((await owner.post('/api/dsp/members/invite', body)).status, 429);
  const token = /token=([A-Za-z0-9_-]{43})/.exec((await capturedMail(f.root, body.email)).text)![1];
  f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare('INSERT OR REPLACE INTO throttle VALUES (?,?,?)')
      .run(
        createHash('sha256').update(`login:email:${body.email}`).digest('hex'),
        10,
        Date.now() + 900000,
      ),
  );
  assert.equal(
    (
      await f.request(`/api/invitations/${token}/accept`, {
        firstName: 'Existing',
        lastName: 'Member',
        password: demo.password,
      })
    ).status,
    429,
  );
  f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare('DELETE FROM throttle WHERE key=?')
      .run(createHash('sha256').update(`mail:cooldown:${body.email}`).digest('hex')),
  );
  assert.equal((await owner.post('/api/dsp/members/invite', body)).status, 200);
  assert.equal((await f.request(`/api/invitations/${token}`)).status, 404);
  const count = f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare('SELECT count(*) n FROM invitations WHERE email=? AND used_at IS NULL')
      .get(body.email),
  );
  assert.equal(count?.n, 1);
});

test('session revocation is account-scoped and cannot revoke another account', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const first = await f.client();
  const second = await f.client();
  const member = await f.client('member@dispatch.test');
  const sessions = (await first.get('/api/auth/security/sessions')).value;
  assert.equal(sessions.length, 2);
  const other = sessions.find((s: { current: boolean }) => !s.current);
  assert.equal((await member.post(`/api/auth/security/sessions/${other.id}/revoke`)).status, 404);
  assert.equal((await first.post(`/api/auth/security/sessions/${other.id}/revoke`)).status, 200);
  assert.equal((await second.get('/api/session')).status, 401);
  assert.equal((await first.get('/api/session')).status, 200);
});

test('retired passkeys do not block existing accounts or invitations and their endpoints are gone', async (t) => {
  const f = await fixture();
  t.after(f.close);
  // Keep an older release's tables for rollback, without using their credentials or verification state.
  f.database('data/platform/accounts.sqlite', (db) =>
    db.exec(`
    INSERT INTO passkeys(id,user_id,credential,name,created_at)
    SELECT 'legacy-' || id,id,'{}','Old security key',0 FROM users;
    INSERT INTO recovery_codes(hash,user_id) SELECT 'legacy-' || id,id FROM users;
  `),
  );
  const owner = await f.client();
  const member = await f.client(demo.member);
  assert.equal('security' in owner.session, false);
  assert.equal('security' in member.session, false);
  assert.equal((await owner.get('/api/platform/dsps')).status, 200);
  assert.equal((await member.get('/api/platform/dsps')).status, 403);
  await member.select(member.session.dsps[0].id);
  assert.equal((await member.get('/api/dsp/employees')).status, 200);
  assert.equal((await member.get('/api/dsp/connections')).status, 403);
  assert.equal((await f.request('/api/auth/security/sessions')).status, 401);
  for (const route of ['status', 'passkeys']) {
    assert.equal((await owner.get(`/api/auth/security/${route}`)).status, 404);
  }
  for (const route of [
    'register/start',
    'register/finish',
    'verify/start',
    'verify/finish',
    'recover',
    'recovery-codes',
    'passkeys/legacy/remove',
    'reauthenticate',
  ]) {
    assert.equal((await owner.post(`/api/auth/security/${route}`, {})).status, 404, route);
  }
  const dsp = owner.session.dsps.find(
    (d: { id: string }) => !member.session.dsps.some((m: { id: string }) => m.id === d.id),
  );
  await owner.select(dsp.id);
  const roles = (await owner.get('/api/dsp/roles')).value;
  const role = roles.find((r: { name: string }) => r.name === 'Member').id;
  assert.equal(
    (await owner.post('/api/dsp/members/invite', { email: demo.member, role })).status,
    200,
  );
  const token = /token=([A-Za-z0-9_-]{43})/.exec(
    (await capturedMail(f.root, demo.member)).text,
  )![1];
  const accept = (password: string) =>
    f.request(`/api/invitations/${token}/accept`, {
      firstName: 'Existing',
      lastName: 'Member',
      password,
    });
  assert.equal((await accept('wrong-password')).status, 403);
  assert.equal((await accept(demo.password)).status, 200);
  const joined = await f.client(demo.member);
  await joined.select(dsp.id);
  assert.equal((await joined.get('/api/dsp/employees')).status, 200);
});
