'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccessHttp } = require('../server/access-http');
test('popup endpoint requires session, CSRF, same-origin JSON and uses the authenticated user', async () => {
  const current = { user: { id: 'owner' }, csrfToken: 'csrf' };
  let calls = 0;
  const route = createAccessHttp({
    access: { requireSession() {}, session: () => current },
    releasePopup: { pending: s => ({ release: s.user.id }), dismiss(s, input) { calls++; assert.equal(s, current); return { release: null }; } },
  });
  async function request(method, headers = {}, path = '/api/updates/popup') {
    let output;
    await route.route({ method, headers }, {}, new URL(path, 'http://localhost'), {
      readJson: async () => ({ releaseId: 'dispatch_1.2.3' }), sendJson: (_, status, body) => { output = body; },
    });
    return output;
  }
  const cookie = 'dispatch_session=' + 'a'.repeat(43);
  await assert.rejects(request('GET'), { code: 'authentication_required' });
  assert.equal((await request('GET', { cookie })).data.release, 'owner');
  await assert.rejects(request('POST', { cookie }), { code: 'csrf_invalid' });
  const headers = { cookie, 'x-dispatch-csrf': 'csrf', 'content-type': 'application/json' };
  await assert.rejects(request('POST', { ...headers, 'sec-fetch-site': 'cross-site' }), { code: 'request_forbidden' });
  await assert.rejects(request('POST', { ...headers, 'content-type': 'text/plain' }), { code: 'content_type_required' });
  await assert.rejects(request('GET', headers, '/api/updates/popup?userId=other'), { code: 'invalid_request' });
  assert.equal((await request('POST', headers)).data.release, null);
  assert.equal(calls, 1);
});
