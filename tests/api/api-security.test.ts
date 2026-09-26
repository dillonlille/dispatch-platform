import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
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
      .prepare(
        "INSERT OR REPLACE INTO throttle(key,count,reset_at,namespace) VALUES (?,?,?,'login')",
      )
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
  f.database('data/platform/accounts.sqlite', (db) =>
    db.prepare('UPDATE sessions SET created_at=0 WHERE user_id=?').run(first.session.user.id),
  );
  assert.equal((await first.post(`/api/auth/security/sessions/${other.id}/revoke`)).status, 403);
  assert.equal(
    (await first.post('/api/auth/security/reauthenticate', { password: demo.password })).status,
    200,
  );
  assert.equal((await first.post(`/api/auth/security/sessions/${other.id}/revoke`)).status, 200);
  assert.equal((await second.get('/api/session')).status, 401);
  assert.equal((await first.get('/api/session')).status, 200);
});

test('authenticator MFA gates new sessions, resists replay, and recovery can disable it', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const other = await f.client();
  // Keep an older release's credential present: rollout requires an explicit new enrollment and
  // must never silently turn MFA on from retired state.
  f.database('data/platform/accounts.sqlite', (db) =>
    db.exec(`
    INSERT INTO passkeys(id,user_id,credential,name,created_at)
    SELECT 'legacy-' || id,id,'{}','Old security key',0 FROM users WHERE email='owner@dispatch.test';
  `),
  );
  assert.deepEqual((await owner.get('/api/auth/security/status')).value, {
    enrolled: false,
    required: false,
    verified: false,
    recent: false,
    passkeyCount: 0,
    authenticator: false,
  });
  assert.deepEqual((await owner.get('/api/auth/security/passkeys')).value, []);

  const setup = (await owner.post('/api/auth/security/authenticator/register/start')).value as {
    secret: string;
    qrCode: string;
  };
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.qrCode, /^data:image\/svg\+xml;base64,/);
  const enrollmentCode = authenticatorCode(setup.secret);
  const finished = await owner.post('/api/auth/security/authenticator/register/finish', {
    code: enrollmentCode,
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.value.codes.length, 10);
  assert.equal(new Set(finished.value.codes).size, 10);
  for (const code of finished.value.codes)
    assert.match(code, /^[A-Za-z0-9_.]{4}(?:-[A-Za-z0-9_.]{4}){3}$/);
  const storage = f.database('data/platform/accounts.sqlite', (db) => ({
    app: db.prepare('SELECT secret,last_counter FROM authenticator_apps').get() as {
      secret: string;
      last_counter: number;
    },
    recovery: db.prepare('SELECT hash FROM recovery_codes').all() as { hash: string }[],
  }));
  assert(!storage.app.secret.includes(setup.secret));
  assert(Math.abs(storage.app.last_counter - Math.floor(Date.now() / 30_000)) <= 1);
  assert.equal(storage.recovery.length, 10);
  for (const code of finished.value.codes)
    assert(!storage.recovery.some((row) => row.hash === code || row.hash.includes(code)));
  assert.equal((await other.get('/api/session')).status, 401, 'enrollment revokes other sessions');

  const gated = await f.client();
  assert.equal(gated.session.security.required, true);
  assert.equal(gated.session.security.verified, false);
  assert.deepEqual(gated.session.dsps, []);
  assert.equal((await gated.get('/api/platform/dsps')).status, 403);
  // A code can be accepted one window ahead for clock skew. Once used, its counter is rejected.
  const code = authenticatorCode(setup.secret, Math.floor(Date.now() / 30_000) + 1);
  assert.equal((await gated.post('/api/auth/security/authenticator/verify', { code })).status, 200);
  assert.equal((await gated.post('/api/auth/security/authenticator/verify', { code })).status, 403);
  const verified = await gated.get('/api/session');
  assert.equal(verified.value.security.verified, true);
  assert(verified.value.dsps.length > 0);

  const recovering = await f.client();
  assert.equal(
    (
      await recovering.post('/api/auth/security/recover', {
        code: finished.value.codes[0],
      })
    ).status,
    200,
  );
  assert.equal((await gated.get('/api/session')).status, 401, 'recovery revokes other sessions');
  assert.equal(
    (
      await recovering.post('/api/auth/security/recover', {
        code: finished.value.codes[0],
      })
    ).status,
    403,
  );
  assert.equal((await recovering.post('/api/auth/security/authenticator/remove')).status, 200);
  const disabled = await recovering.get('/api/session');
  assert.equal(disabled.value.security.enrolled, false);
  assert.equal(disabled.value.security.required, false);
  assert.equal(
    f.database(
      'data/platform/accounts.sqlite',
      (db) => (db.prepare('SELECT count(*) n FROM recovery_codes').get() as { n: number }).n,
    ),
    0,
  );
});

function authenticatorCode(secret: string, counter = Math.floor(Date.now() / 30_000)) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  const key: number[] = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(key)).update(message).digest();
  const offset = digest[19]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) >>>
    0;
  return String(value % 1_000_000).padStart(6, '0');
}
