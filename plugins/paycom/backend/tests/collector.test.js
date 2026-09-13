'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { validateRequest, periodsFor, resolvedTargets, safeFailure } = require('../src/collector');
const { ROSTER_REQUEST_FIELDS, rosterRequest, rosterAuthorityAssessment, fetchRosterRequest,
  rosterMembershipAssessment, rosterMembership, collectTimecards } = require('../src/browser');
const { periodContaining } = require('../src/timecard-period');
const { resolveObservedEmployeeCode } = require('../src/timecard-dom');
const { boundedJson } = require('dispatch-runtime-kit/collection-manager/src/validation');

function request(method = 'collector.health', input = {}) {
  return {
    protocolVersion: 1,
    runId: 'run-1',
    plan: 'paycom-health',
    source: { id: 'paycom-main', collector: 'paycom', authProfile: 'paycom-main', config: { timezone: 'America/Los_Angeles', maxConcurrency: 3 } },
    method,
    input,
    attempt: 1,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

test('collector request contract is closed and supports all registered methods', () => {
  assert.equal(validateRequest(request()).method, 'collector.health');
  assert.equal(validateRequest(request('timecards.period', { periodEnd: '2026-09-05' })).input.periodEnd, '2026-09-05');
  assert.equal(validateRequest(request('timecards.from-published-roster', { periodEnd: '2026-09-05' })).input.periodEnd, '2026-09-05');
  assert.equal(validateRequest(request('timecards.audit', { periodEnd: '2026-09-05' })).input.periodEnd, '2026-09-05');
  assert.equal(validateRequest(request('roster.period', { periodEnd: '2026-09-05' })).input.periodEnd, '2026-09-05');
  assert.equal(validateRequest(request('resource-links.current-period', { resourceType: 'paycom.timecard.summary' })).input.resourceType, 'paycom.timecard.summary');
  assert.equal(validateRequest(request('resource-links.audit', { resourceType: 'paycom.timecard.summary', periodEnd: '2026-09-05' })).input.periodEnd, '2026-09-05');
  const syncInput = {
    reconcileBatchSize: 10, fullReconcileMinutes: 1440,
    lookbackPeriods: 1, publishMode: 'additions_edits',
  };
  assert.equal(validateRequest(request('sync.current-workforce', syncInput)).input.publishMode, 'additions_edits');
  assert.throws(() => validateRequest(request('sync.current-workforce', { ...syncInput, lookbackPeriods: 2 })), /invalid_request/);
  assert.equal(validateRequest(request('sync.current-workforce', {
    ...syncInput, publishMode: 'additions_edits_preview',
  })).input.publishMode, 'additions_edits_preview');
  assert.throws(() => validateRequest(request('sync.current-workforce', { ...syncInput, publishMode: 'deletions' })), /invalid_request/);
  assert.throws(() => validateRequest({ ...request(), password: 'forbidden' }), /invalid_request/);
  assert.throws(() => validateRequest(request('timecards.period', {})), /invalid_request/);
  assert.throws(() => validateRequest(request('timecards.incremental', { periodEnd: '2026-09-05' })), /invalid_request/);
  assert.throws(() => validateRequest(request('resource-links.current-period', { resourceType: 'paycom.arbitrary' })), /invalid_request/);
  assert.throws(() => validateRequest({ ...request(), source: { ...request().source, config: { timezone: 'UTC', maxConcurrency: 7 } } }), /invalid_request/);
});

test('period discovery returns one previous, current, and next period', () => {
  const rows = periodsFor('2026-08-25');
  assert.deepEqual(rows.map(row => row.relation), ['previous', 'current', 'next']);
  assert.equal(rows[1].key, periodContaining('2026-08-25').key);
});

test('standard selectors resolve to unique exact Paycom pay periods without collecting', () => {
  const date = resolvedTargets({ selectorKind: 'date', date: '2026-08-18' });
  assert.equal(date.targetType, 'pay-period');
  assert.deepEqual(date.targets.map(target => target.key), ['2026-08-22']);
  assert.deepEqual(resolvedTargets({ selectorKind: 'latest-complete', date: '2026-08-18' }).targets.map(target => target.key), ['2026-08-08']);
  assert.deepEqual(resolvedTargets({ selectorKind: 'date-range', start: '2026-08-01', end: '2026-08-31' }).targets.map(target => target.key),
    ['2026-08-08', '2026-08-22', '2026-09-05']);
  assert.deepEqual(resolvedTargets({ selectorKind: 'exact-target', key: '2026-09-05' }).targets[0].values, { periodEnd: '2026-09-05' });
  assert.equal(validateRequest(request('collection.resolve-targets', { selectorKind: 'date', date: '2026-08-18' })).method, 'collection.resolve-targets');
  assert.throws(() => validateRequest(request('collection.resolve-targets', { selectorKind: 'date-range', start: '2026-08-01' })), /invalid_request/);
});

test('roster interception accepts only exact API membership and period bounds', () => {
  const period = periodContaining('2026-08-25');
  const event = {
    requestId: 'request-1',
    request: {
      method: 'POST',
      url: 'https://time-and-attendance.paycomonline.net/api/cl/timecard-search/employees',
      postData: JSON.stringify({ startDate: period.start, endDate: period.end, eeCodes: ['A001', 'A002'] }),
    },
  };
  assert.deepEqual(rosterRequest(event, period), { requestId: 'request-1', codes: ['A001', 'A002'] });
  assert.equal(rosterRequest({ ...event, request: { ...event.request, url: `${event.request.url}/evil` } }, period), null);
  assert.equal(rosterRequest({ ...event, request: { ...event.request, url: `${event.request.url}?unexpected=1` } }, period), null);
  assert.equal(rosterMembership(Buffer.from(JSON.stringify({ eeCodes: ['A002', 'A001'] })), ['A001', 'A002']), true);
  assert.equal(rosterMembership(Buffer.from(JSON.stringify({ eeCodes: ['A001'] })), ['A001', 'A002']), false);
  assert.deepEqual(rosterMembershipAssessment(
    Buffer.from(JSON.stringify({ eeCodes: ['A001'] })), ['A001', 'A002'],
  ), { exact: false, returnedCount: 1 });
  assert.equal(rosterMembershipAssessment(
    Buffer.from(JSON.stringify({ eeCodes: ['A003'] })), ['A001', 'A002'],
  ), null);
  const fetchBody = Object.fromEntries(ROSTER_REQUEST_FIELDS.map(key => [key, null]));
  Object.assign(fetchBody, { startDate: '2026-08-09', endDate: '2026-08-22', eeCodes: ['A001', 'A002'] });
  const fetchRequest = fetchRosterRequest({
    requestId: 'fetch-1', request: { method: 'POST', url: event.request.url, postData: JSON.stringify(fetchBody) },
  }, period);
  assert.deepEqual(fetchRequest.codes, ['A001', 'A002']);
  assert.deepEqual(fetchRequest.uiPeriod, { start: '2026-08-09', end: '2026-08-22' });
  const rewritten = JSON.parse(Buffer.from(fetchRequest.postData, 'base64').toString('utf8'));
  assert.equal(rewritten.startDate, period.start);
  assert.equal(rewritten.endDate, period.end);
  assert.equal(fetchRosterRequest({
    requestId: 'fetch-1', request: { method: 'POST', url: event.request.url, postData: JSON.stringify({ ...fetchBody, unexpected: true }) },
  }, period), null);
});

test('bounded timecard workers reuse browser targets and emit identifier-free performance metrics', async () => {
  const employees = Array.from({ length: 8 }, (_, index) => ({ employeeCode: `A00${index}`, employeeName: `Employee ${index}` }));
  let opened = 0;
  let closed = 0;
  let active = 0;
  let peak = 0;
  const uses = [];
  const result = await collectTimecards('http://127.0.0.1:1', employees, periodContaining('2026-08-25'), 3, () => {}, {
    openSession: async workerIndex => {
      opened += 1;
      uses[workerIndex] = 0;
      return {
        collect: async (employee, collectedPeriod, variant, onTiming) => {
          uses[workerIndex] += 1;
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          onTiming({ navigateMs: 10, responseMs: 20, loadMs: 30, bodyMs: 40, readyMs: 50, extractMs: 60, validateMs: 70 });
          return { employeeCode: employee.employeeCode };
        },
        close: async () => { closed += 1; },
      };
    },
  });
  assert.equal(result.rows.length, employees.length);
  assert.equal(opened, 3);
  assert.equal(closed, 3);
  assert.equal(peak, 3);
  assert.equal(uses.some(count => count > 1), true);
  const phases = ['targetOpen', 'navigate', 'response', 'load', 'body', 'ready', 'extract', 'validate'];
  assert.deepEqual(Object.keys(result.performance).sort(), [
    'itemCount', 'itemMaxMs', 'itemP50Ms', 'itemP95Ms', 'openedTargets', 'retryCount', 'totalMs', 'workerCount',
    ...phases.flatMap(phase => [`${phase}MaxMs`, `${phase}P50Ms`, `${phase}P95Ms`]),
  ].sort());
  assert.equal(result.performance.navigateP50Ms, 10);
  assert.equal(result.performance.validateP95Ms, 70);
  assert.equal(JSON.stringify(result.performance).includes('Employee'), false);
  assert.doesNotThrow(() => boundedJson({ performance: result.performance }));
});

test('timecard workers enforce one absolute item deadline and recycle only the timed-out session', async () => {
  const employees = [{ employeeCode: 'A001', employeeName: 'Employee 1' }];
  let opened = 0;
  let closed = 0;
  const result = await collectTimecards('http://127.0.0.1:1', employees, periodContaining('2026-08-25'), 1, () => {}, {
    itemTimeoutMs: 20,
    openSession: async (workerIndex, signal) => {
      opened += 1;
      const attempt = opened;
      return {
        collect: async (employee, period, variant, onTiming) => {
          if (attempt === 1) {
            await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'acquisition_cancelled' })), { once: true }));
          }
          onTiming({ navigateMs: 1, responseMs: 1, loadMs: 1, bodyMs: 1, readyMs: 1, extractMs: 1, validateMs: 1 });
          return { employeeCode: employee.employeeCode };
        },
        close: async () => { closed += 1; },
      };
    },
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.performance.retryCount, 1);
  assert.equal(opened, 2);
  assert.equal(closed, 2);
});

test('rendered timecard identity must be present, singular, and internally consistent', () => {
  assert.equal(resolveObservedEmployeeCode(['a001', 'A001']), 'A001');
  assert.equal(resolveObservedEmployeeCode([]), '');
  assert.equal(resolveObservedEmployeeCode(['A001', 'A002']), '');
  assert.equal(resolveObservedEmployeeCode(['not-an-employee']), '');
});

test('collector failures expose only stable sanitized error codes', () => {
  for (const code of ['invalid_credentials', 'primary_credentials_rejected', 'security_answers_rejected', 'browser_profile_busy']) {
    assert.deepEqual(safeFailure(Object.assign(new Error('details'), { code })), { ok: false, status: 'failed', data: null, error: { code } });
  }
  assert.equal(safeFailure(new Error('password=secret')).error.code, 'collection_failed');
});

test('worker rejects duplicate JSON keys with one sanitized receipt', () => {
  const worker = path.resolve(__dirname, "../bin/dispatch-paycom-collector");
  const result = spawnSync(worker, [], { input: '{"protocolVersion":1,"protocolVersion":1}\n', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, status: 'failed', data: null, error: { code: 'invalid_request' } });
  assert.equal(result.stderr, '');
});

test('sync roster request clears saved soft filters while preserving closed request and full-membership guards', () => {
  const period = periodContaining('2026-09-08');
  const body = { ...Object.fromEntries(ROSTER_REQUEST_FIELDS.map(key => [key, null])),
    startDate: period.start, endDate: period.end, eeCodes: ['A001', 'A002'],
    q: '', isAdvancedFilterApplied: true, onlyBorrowedEmployees: false,
    payClassCodes: 'selected-class', selectedEarnings: [], approvalMode: 0,
  };
  const event = selected => ({ requestId: 'unfiltered-roster', request: {
    method: 'POST', url: 'https://time-and-attendance.paycomonline.net/api/cl/timecard-search/employees',
    postData: JSON.stringify(selected),
  } });
  assert.equal(fetchRosterRequest(event(body), period).authoritative, false);
  const request = fetchRosterRequest(event(body), period, { unfiltered: true });
  assert.equal(request.authoritative, true);
  assert.deepEqual(request.codes, ['A001', 'A002']);
  const sent = JSON.parse(Buffer.from(request.postData, 'base64').toString());
  assert.equal(sent.isAdvancedFilterApplied, false);
  assert.equal(sent.payClassCodes, 'selected-class');
  assert.equal(sent.approvalMode, null);
  assert.equal(body.isAdvancedFilterApplied, true, 'Never change saved UI preferences');
  for (const patch of [{ q: 'employee' }, { skip: 1 }, { onlyBorrowedEmployees: true }, { isAdvancedFilterApplied: null }]) {
    const refused = fetchRosterRequest(event({ ...body, ...patch }), period, { unfiltered: true });
    assert.equal(refused.observable, false);
    assert.equal(refused.authoritative, false);
  }
  assert.equal(fetchRosterRequest(event({ ...body, unexpected: true }), period, { unfiltered: true }), null);
  assert.equal(rosterMembership(Buffer.from(JSON.stringify({ eeCodes: ['A001'] })), request.codes), false);
});

for (const readFails of [false, true]) test(`roster capture owns a fresh page and closes it after ${readFails ? 'failure' : 'success'}`, async t => {
  const http = require('node:http');
  const { CdpConnection } = require('../../../../runtime/auth-broker/src/cdp');
  const { collectRoster, ROSTER_API, TIMECARD_SEARCH_URL } = require('../src/browser');
  const period = periodContaining('2026-09-08');
  const body = { ...Object.fromEntries(ROSTER_REQUEST_FIELDS.map(key => [key, null])),
    startDate: period.start, endDate: period.end, eeCodes: ['A001', 'A002'],
    q: '', isAdvancedFilterApplied: true, onlyBorrowedEmployees: false, payClassCodes: 'selected', approvalMode: 0 };
  const requestEvent = { requestId: 'request', networkId: 'network-original', request: {
    method: 'POST', url: ROSTER_API, headers: { Authorization: 'Bearer fixture-session', 'Content-Type': 'application/json' }, postData: JSON.stringify(body) } };
  const calls = [];
  let navigated = false, resolveRequest;
  const socket = new EventTarget();
  const connection = {
    socket, close() {},
    evaluate: async expression => {
      return require('node:vm').runInNewContext(expression, { AbortSignal, TextDecoder, fetch: async (url, options) => {
        assert.equal(url, ROSTER_API);
        assert.equal(options.redirect, 'error');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers.Authorization, 'Bearer fixture-session');
        const sent = JSON.parse(options.body);
        assert.equal(sent.startDate, period.start);
        assert.equal(sent.endDate, period.end);
        assert.equal(sent.isAdvancedFilterApplied, false);
        assert.equal(sent.payClassCodes, 'selected');
        if (readFails) return new Response('unavailable', { status: 503 });
        return new Response(JSON.stringify({ eeCodes: ['A001', 'A002'], employees: [] }), { headers: { 'Content-Type': 'application/json' } });
      } });
    },
    waitFor: async (method, accepts) => {
      assert.equal(method, 'Fetch.requestPaused');
      assert.equal(accepts(requestEvent), true);
      return new Promise(resolve => { resolveRequest = resolve; });
    },
    command: async (name, params = {}) => {
      calls.push([name, params]);
      if (name === 'Fetch.enable') assert.equal(navigated, false, 'Install capture while the new page is still blank');
      if (name === 'Page.navigate') {
        assert.equal(params.url, TIMECARD_SEARCH_URL);
        navigated = true;
        resolveRequest(requestEvent);
        for (const params of [requestEvent,
          { requestId: 'preflight', request: { method: 'OPTIONS', url: ROSTER_API } },
          { ...requestEvent, requestId: 'dependent-request', networkId: 'dependent-network' }]) {
          socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Fetch.requestPaused', params }) }));
        }
      }
      if (name === 'Fetch.continueRequest' && params.requestId === 'request') {
        assert.equal(params.postData, undefined, 'Preserve the original page request');
      }
      return {};
    },
  };
  t.mock.method(CdpConnection, 'connect', async url => {
    assert.ok(url.endsWith('/devtools/page/capture'), 'Never reuse the handoff page and its pending requests');
    return connection;
  });
  const browserCalls = [];
  const server = http.createServer((request, response) => {
    browserCalls.push([request.method, request.url]);
    if (request.method === 'PUT' && request.url === '/json/new?about%3Ablank') return response.end(JSON.stringify({
      type: 'page', id: 'capture', url: 'about:blank',
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/capture`,
    }));
    if (request.url === '/json/close/capture') return response.end(JSON.stringify({ success: true }));
    response.writeHead(400); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const collection = collectRoster(`http://127.0.0.1:${server.address().port}`, period, { unfiltered: true });
  if (readFails) await assert.rejects(collection, { code: 'roster_response_invalid' });
  else assert.equal((await collection).completeness.authoritative, true);
  assert.deepEqual(browserCalls, [['PUT', '/json/new?about%3Ablank'], ['GET', '/json/close/capture']]);
  assert.ok(calls.some(([method, params]) => method === 'Fetch.continueRequest' && params.requestId === 'preflight'));
  assert.ok(calls.some(([method, params]) => method === 'Fetch.continueRequest' && params.requestId === 'dependent-request'));
  assert.equal(calls.filter(([method]) => method === 'Fetch.enable').length, 1, 'Do not change interception while the request is paused');
  assert.ok(calls.some(([method]) => method === 'Fetch.disable'));
});

test('dedicated roster reads bound response size and reject non-JSON, redirects, and timeouts', async () => {
  const { rosterReadExpression } = require('../src/browser');
  const expression = rosterReadExpression({ headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const run = fetch => require('node:vm').runInNewContext(expression, { fetch, AbortSignal, TextDecoder });
  assert.equal((await run(async () => new Response('login page', { headers: { 'Content-Type': 'text/html' } }))).error, 'invalid_response');
  assert.equal((await run(async () => new Response(new Uint8Array(2_097_153), { headers: { 'Content-Type': 'application/json' } }))).error, 'too_large');
  assert.equal((await run(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new TypeError('redirect rejected');
  })).error, 'request_failed');
  assert.equal((await run(async () => { throw Object.assign(new Error(), { name: 'TimeoutError' }); })).error, 'timeout');
});


test('timecard sessions subscribe to network events before navigating and clean up on invalid HTML', async t => {
  const http = require('node:http');
  const { CdpConnection } = require('../../../../runtime/auth-broker/src/cdp');
  const { collectOneTimecard } = require('../src/browser');
  let networkEnabled = false, navigated = false, closed = false;
  const connection = {
    close() { closed = true; },
    command: async (method) => {
      if (method === 'Network.enable') networkEnabled = true;
      if (method === 'Network.disable') networkEnabled = false;
      if (method === 'Page.navigate') {
        assert.equal(networkEnabled, true, 'Response events require a subscription on this session');
        navigated = true;
        return { loaderId: 'loader' };
      }
      if (method === 'Network.getResponseBody') return { body: '<html>Incomplete timecard</html>' };
      return {};
    },
    waitFor: async () => ({ requestId: 'response' }),
  };
  t.mock.method(CdpConnection, 'connect', async () => connection);
  const server = http.createServer((_request, response) => response.end(JSON.stringify({
    type: 'page', id: 'fixture', url: 'about:blank',
    webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/fixture`,
  })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(collectOneTimecard(`http://127.0.0.1:${server.address().port}`,
    { employeeCode: 'A001', employeeName: 'Fixture' }, periodContaining('2026-09-08')), /timecard_html_invalid/);
  assert.equal(navigated, true);
  assert.equal(networkEnabled, false);
  assert.equal(closed, true);
});
