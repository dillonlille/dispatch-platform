import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fixture, until } from './rust-support.js';
import { jobSchema, parseApiResponse, sessionSchema } from '../shared/contracts/runtime.js';

test('trusted tunnel clients have separate IP allowances and retain account throttling', async (t) => {
  const f = await fixture({ env: { DISPATCH_TRUSTED_PROXY: 'cloudflare' } });
  t.after(f.close);
  const full = (key: string, count: number) =>
    f.database('data/platform/accounts.sqlite', (db) =>
      db
        .prepare('INSERT OR REPLACE INTO throttle VALUES (?,?,?)')
        .run(createHash('sha256').update(key).digest('hex'), count, Date.now() + 900000),
    );
  full('login:ip:203.0.113.1', 30);
  const body = { email: 'owner@dispatch.test', password: 'Dispatch-demo-2026!' };
  const login = (ip: string) => f.request('/api/auth/login', body, { 'cf-connecting-ip': ip });
  assert.equal((await login('203.0.113.1')).status, 429);
  assert.equal((await login('203.0.113.2')).status, 200);
  full('login:email:owner@dispatch.test', 10);
  assert.equal((await login('203.0.113.3')).status, 429);
  assert.equal((await login('203.0.113.3, 203.0.113.4')).status, 400);
});

test('untrusted forwarding headers cannot bypass the peer throttle', async (t) => {
  const f = await fixture({ env: { DISPATCH_TRUSTED_PROXY: 'none' } });
  t.after(f.close);
  f.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare('INSERT INTO throttle VALUES (?,?,?)')
      .run(
        createHash('sha256').update('login:ip:127.0.0.1').digest('hex'),
        30,
        Date.now() + 900000,
      ),
  );
  const result = await f.request(
    '/api/auth/login',
    { email: 'owner@dispatch.test', password: 'Dispatch-demo-2026!' },
    {
      'cf-connecting-ip': '203.0.113.1',
      'x-forwarded-for': '203.0.113.2',
      forwarded: 'for=203.0.113.3',
    },
  );
  assert.equal(result.status, 429);
});

test('production rejects conflicting modes and unsafe defaults before opening storage', async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  const binary = path.resolve(process.env.DISPATCH_TEST_BINARY ?? 'target/debug/dispatch-backend');
  const production = {
    ...f.env,
    NODE_ENV: undefined,
    DISPATCH_ENVIRONMENT: 'production',
    DISPATCH_ORIGIN: 'https://dispatch.example',
    DISPATCH_PROVIDER_MODE: 'native',
    DISPATCH_PRODUCTION_MAIL_MODE: 'disabled',
  };
  const status = (env: NodeJS.ProcessEnv) =>
    spawnSync(binary, ['status'], { env, encoding: 'utf8' });
  assert.equal(
    status(production).status,
    0,
    'Production must default to production behavior without NODE_ENV',
  );
  for (const overrides of [
    { NODE_ENV: 'development' },
    { NODE_ENV: 'test' },
    { DISPATCH_PROVIDER_MODE: 'fixture' },
    { DISPATCH_PRODUCTION_MAIL_MODE: 'capture' },
    { DISPATCH_ORIGIN: 'http://dispatch.example' },
    { DISPATCH_STATE_ROOT: undefined },
    { DISPATCH_ORIGIN: undefined },
  ])
    assert.notEqual(status({ ...production, ...overrides }).status, 0, JSON.stringify(overrides));
  assert.match(status({ ...f.env, NODE_ENV: 'typo' }).stderr, /invalid_runtime_mode/);
  assert.match(
    status({ ...f.env, DISPATCH_PROVIDER_MODE: 'typo' }).stderr,
    /invalid_provider_mode/,
  );
  assert.match(status({ ...f.env, DISPATCH_TRUSTED_PROXY: 'all' }).stderr, /invalid_trusted_proxy/);
});

test('authentication and job contracts reject malformed values and validate real responses', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const body of [
    { email: 'owner@dispatch.test' },
    { email: 'owner@dispatch.test', password: 12 },
    { email: 'owner@dispatch.test', password: 'test', extra: true },
  ])
    assert.equal((await f.request('/api/auth/login', body)).status, 400);
  const owner = await f.client();
  assert(sessionSchema.safeParse(owner.session).success);
  assert.throws(
    () =>
      parseApiResponse('/api/session', 'GET', {
        ...owner.session,
        user: { ...owner.session.user, platformOwner: 'yes' },
      }),
    /invalid_api_response/,
  );
  await owner.select(
    owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics').id,
  );
  for (const body of [
    { requestId: 'test', date: null },
    { requestId: 1 },
    { requestId: 'test', extra: true },
  ])
    assert.equal((await owner.post('/api/dsp/jobs', body)).status, 400);
  const job = (await owner.post('/api/dsp/jobs', { requestId: 'typed-job' })).value;
  assert.equal(jobSchema.parse(job).status, 'queued');
  await until(async () => {
    const jobs = (await owner.get('/api/dsp/jobs')).value;
    parseApiResponse('/api/dsp/jobs', 'GET', jobs);
    return jobs.find((j: { id: string }) => j.id === job.id).status === 'succeeded';
  });
  for (const invalid of [
    { ...job, status: 'finished' },
    { ...job, attempt: '0' },
    { ...job, metrics: [{}] },
    { ...job, error: undefined },
  ])
    assert.throws(() => parseApiResponse('/api/dsp/jobs', 'POST', invalid), /invalid_api_response/);
  for (const route of [
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/password',
    '/api/auth/reset-password',
    '/api/auth/forgot-password',
  ]) {
    assert.deepEqual(parseApiResponse(route, 'POST', { ok: true }), { ok: true });
    assert.throws(() => parseApiResponse(route, 'POST', { ok: 'yes' }), /invalid_api_response/);
  }
});

test('request IDs correlate sanitized failure logs without logging secrets or invite tokens', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const token = 'private-invitation-token';
  const result = await f.request(`/api/invitations/${token}?secret=private-query`, undefined, {
    'x-request-id': 'untrusted-request-id',
  });
  assert.equal(result.status, 404);
  const id = result.headers.get('x-request-id');
  assert.match(id!, /^req_[a-f0-9]{32}$/);
  await until(async () => f.logs().includes(id!));
  const events = f
    .logs()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const event = events.find((e) => e.fields?.requestId === id);
  assert.equal(event.event, 'http.request');
  assert.equal(event.fields.error, 'invitation_expired');
  assert.equal(event.fields.route, '/api/invitations/:token/*');
  for (const secret of [token, 'private-query', 'untrusted-request-id', 'Dispatch-demo-2026!'])
    assert(!f.logs().includes(secret));
});
