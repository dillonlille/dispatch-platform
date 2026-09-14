import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import type { BrowserInput } from '../shared/browser.js';

test('private verification frames, inputs and Submit require the current DSP session, owner access and CSRF', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const client = await f.client();
  const dsp = client.session.dsps.find((d) => d.name === 'Northline Logistics')!;
  const other = client.session.dsps.find((d) => d.name === 'Summit Delivery')!;
  await client.select(dsp.id);
  await f.runtime.broker.save(
    dsp,
    { clientCode: 'fixture', username: 'fixture', password: 'require-verification' },
    client.session.user.id,
  );
  const session = f.runtime.browsers.sessions.get(dsp.id)!;
  Object.defineProperty(session, 'interactive', { get: () => true });
  let reads = 0,
    inputs = 0,
    submits = 0;
  t.mock.method(session, 'screenshot', async (guard = () => {}) => {
    guard();
    reads++;
    return 'fixture-frame';
  });
  t.mock.method(session, 'assist', async (_input: BrowserInput, guard = () => {}) => {
    guard();
    inputs++;
  });
  t.mock.method(session, 'submit', async (guard = () => {}) => {
    guard();
    submits++;
  });
  const sessionId = session.id;
  const input = { kind: 'pointer', phase: 'down', pressed: true, x: 1200, y: 500 };
  assert.equal((await client.get('/api/dsp/connections')).json().verificationSessionId, sessionId);
  assert.deepEqual(
    (await client.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`)).json(),
    { image: 'fixture-frame', sessionId },
  );
  assert.equal(
    (await client.post('/api/dsp/connections/paycom/assist', { sessionId, input })).statusCode,
    200,
  );
  assert.equal(
    (await client.post('/api/dsp/connections/paycom/submit', { sessionId })).statusCode,
    200,
  );
  for (const route of ['assist', 'submit']) {
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/dsp/connections/paycom/${route}`,
      headers: { ...client.headers, 'x-csrf-token': 'wrong' },
      payload: { sessionId, ...(route === 'assist' ? { input } : {}) },
    });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(
    (
      await client.post('/api/dsp/connections/paycom/assist', {
        sessionId,
        input: { ...input, x: 1e9 },
      })
    ).statusCode,
    400,
  );
  await client.select(other.id);
  assert.equal(
    (await client.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`)).statusCode,
    409,
  );
  assert.equal(
    (await client.post('/api/dsp/connections/paycom/assist', { sessionId, input })).statusCode,
    409,
  );
  assert.equal(
    (await client.post('/api/dsp/connections/paycom/submit', { sessionId })).statusCode,
    409,
  );
  const member = await f.client('member@dispatch.test');
  await member.select(dsp.id);
  assert.equal(
    (await member.get(`/api/dsp/connections/paycom/screenshot?sessionId=${sessionId}`)).statusCode,
    403,
  );
  assert.equal(
    (await member.post('/api/dsp/connections/paycom/assist', { sessionId, input })).statusCode,
    403,
  );
  assert.equal(
    (await member.post('/api/dsp/connections/paycom/submit', { sessionId })).statusCode,
    403,
  );
  assert.deepEqual([reads, inputs, submits], [1, 1, 1]);
});
