'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { withCdfBrowser } = require('../src/authenticated-browser');
const {
  MAX_LIVE_CSV_BYTES, exactUrl, buildFeedbackUrl, buildQualityUrl, buildProviderApiUrl,
  approvedDownloadUrl, classifyPageSnapshot, downloadExpression, providerFetchExpression,
  decodeCsvPayload, normalizeProviderPayload,
  collectWeeklyFromEndpoint, collectWeeklyArtifacts,
} = require('../src/amazon-weekly');
const { validateProviderJson } = require('../src/validation');

const csv = fs.readFileSync(path.join(__dirname, "./fixtures/2026-W20.csv"));
const source = {
  timezone: 'America/Los_Angeles', station: 'TST1', companyId: 'fixture-company', dsp: 'fixture-dsp',
};
function request() {
  return {
    protocolVersion: 1,
    runId: 'run_weekly_source',
    plan: 'cdf-week-collect',
    source: { id: 'cdf-example', collector: 'cdf', authProfile: 'amazon-example', config: { ...source } },
    method: 'cdf.week.collect',
    input: { week: '2026-W20', replace: false },
    attempt: 1,
    deadline: new Date(Date.now() + 120_000).toISOString(),
  };
}
function feedbackSnapshot(url, overrides = {}) {
  return {
    url, readyState: 'complete', authenticationRequired: false, challengePresent: false,
    unavailable: false, feedbackReady: true, qualityReady: false, weekVisible: true,
    links: [{
      name: 'Customer_Delivery_Feedback_negative_2026-W20.csv',
      href: 'https://logistics.amazon.com/performance/downloads/Customer_Delivery_Feedback_negative_2026-W20.csv',
    }],
    ...overrides,
  };
}
function qualitySnapshot(url, overrides = {}) {
  return {
    url, readyState: 'complete', authenticationRequired: false, challengePresent: false,
    unavailable: false, feedbackReady: false, qualityReady: true, weekVisible: false, links: [],
    ...overrides,
  };
}
function providerPayload() {
  return {
    status: 'downloaded',
    text: JSON.stringify({
      tableData: {
        da_dsp_weekly_cdf: {
          rows: [{
            da_name: 'Fixture Driver', transporter_id: 'transporter-1',
            provider_id: 'amzn1.flex.provider.v1.12345678',
          }],
        },
      },
    }),
  };
}

function fakeConnection({ provider = providerPayload(), unavailable = false } = {}) {
  let currentUrl = 'https://logistics.amazon.com/operations/execution';
  let closed = false;
  return {
    get closed() { return closed; },
    async command(method, params = {}) {
      if (method === 'Page.navigate') currentUrl = params.url;
      return {};
    },
    async evaluate(expression) {
      const page = new URL(currentUrl);
      if (expression.includes('authenticationRequired:')) {
        if (page.searchParams.get('pageId') === 'dsp_customer_delivery_feedback_negative') {
          return feedbackSnapshot(currentUrl, unavailable ? { unavailable: true, feedbackReady: false, links: [] } : {});
        }
        return qualitySnapshot(currentUrl);
      }
      if (expression.includes(`maximum=${MAX_LIVE_CSV_BYTES}`)) {
        return {
          status: 'downloaded', name: 'Customer_Delivery_Feedback_negative_2026-W20.csv',
          type: 'text/csv; charset=utf-8', base64: csv.toString('base64'),
        };
      }
      if (expression.includes('da_dsp_weekly_cdf')) return provider;
      throw new Error('unexpected_expression');
    },
    close() { closed = true; },
  };
}

test('weekly Amazon URLs are fixed, exact-week, and source-bound', () => {
  const feedback = buildFeedbackUrl({ week: '2026-W20', station: 'TST1', companyId: 'fixture-company' });
  const quality = buildQualityUrl({ week: '2026-W20', station: 'TST1', companyId: 'fixture-company' });
  const api = buildProviderApiUrl({ week: '2026-W20', station: 'TST1', dsp: 'fixture-dsp' });
  assert.equal(exactUrl(feedback, feedback), true);
  assert.equal(exactUrl(`${feedback}&unexpected=1`, feedback), false);
  assert.equal(new URL(feedback).searchParams.get('to'), '2026-W20');
  assert.equal(new URL(quality).searchParams.get('pageId'), 'dsp_quality');
  assert.deepEqual([new URL(api).searchParams.get('from'), new URL(api).searchParams.get('to')], ['2026-W20', '2026-W20']);
  assert.equal(approvedDownloadUrl('https://logistics.amazon.com/performance/downloads/Customer_Delivery_Feedback_negative_2026-W20.csv'), true);
  assert.equal(approvedDownloadUrl('https://evil.amazonaws.com/Customer_Delivery_Feedback_negative.csv'), false);
  assert.equal(approvedDownloadUrl('https://logistics.amazon.com/wrong/Customer_Delivery_Feedback_negative.csv'), false);
  assert.equal(approvedDownloadUrl('https://logistics.amazon.com/performance/downloads/Customer_Delivery_Feedback_negative.csv?extra=1'), false);
  assert.equal(approvedDownloadUrl('https://evil.example/report.csv'), false);
  assert.doesNotThrow(() => new Function(`return ${downloadExpression(feedback)}`));
  assert.doesNotThrow(() => new Function(`return ${providerFetchExpression({ qualityUrl: quality, apiUrl: api })}`));
});

test('generated browser expressions execute bounded authenticated downloads', async () => {
  const feedback = buildFeedbackUrl({ week: '2026-W20', station: 'TST1', companyId: 'fixture-company' });
  const quality = buildQualityUrl({ week: '2026-W20', station: 'TST1', companyId: 'fixture-company' });
  const api = buildProviderApiUrl({ week: '2026-W20', station: 'TST1', dsp: 'fixture-dsp' });
  const download = 'https://logistics.amazon.com/performance/downloads/Customer_Delivery_Feedback_negative_2026-W20.csv';
  const reader = bytes => {
    let sent = false;
    return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; }, async cancel() {} };
  };
  const common = {
    URL, Uint8Array, TextDecoder,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
  };
  const csvPayload = await vm.runInNewContext(downloadExpression(feedback), {
    ...common,
    location: { href: feedback },
    document: { querySelectorAll: () => [{ disabled: false, offsetParent: {}, download: path.basename(download), href: download }] },
    fetch: async () => ({
      ok: true, url: download,
      headers: { get: name => name === 'content-type' ? 'text/csv; charset=utf-8' : name === 'content-length' ? String(csv.length) : null },
      body: { getReader: () => reader(new Uint8Array(csv)) },
    }),
  });
  assert.deepEqual(decodeCsvPayload(JSON.parse(JSON.stringify(csvPayload))), csv);

  const providerText = providerPayload().text;
  const providerPayloadResult = await vm.runInNewContext(providerFetchExpression({ qualityUrl: quality, apiUrl: api }), {
    ...common,
    location: { href: quality },
    fetch: async () => ({
      ok: true, status: 200, url: api,
      headers: { get: name => name === 'content-type' ? 'application/json' : name === 'content-length' ? String(Buffer.byteLength(providerText)) : null },
      body: { getReader: () => reader(new TextEncoder().encode(providerText)) },
    }),
  });
  const normalizedProvider = normalizeProviderPayload(JSON.parse(JSON.stringify(providerPayloadResult)), '2026-W20');
  assert.equal(validateProviderJson(normalizedProvider, '2026-W20').rowCount, 1);
});

test('weekly page classification distinguishes ready, unavailable, authentication, and challenge states', () => {
  const feedback = buildFeedbackUrl({ week: '2026-W20', station: 'TST1', companyId: 'fixture-company' });
  const options = { expectedUrl: feedback, kind: 'feedback' };
  assert.equal(classifyPageSnapshot(feedbackSnapshot(feedback), options), 'ready');
  assert.equal(classifyPageSnapshot(feedbackSnapshot(feedback, { unavailable: true }), options), 'week_unavailable');
  assert.equal(classifyPageSnapshot(feedbackSnapshot(feedback, { authenticationRequired: true }), options), 'authentication_required');
  assert.equal(classifyPageSnapshot(feedbackSnapshot(feedback, { challengePresent: true }), options), 'manual_verification_required');
  assert.equal(classifyPageSnapshot(feedbackSnapshot(`${feedback}&extra=1`), options), 'source_page_invalid');
  assert.equal(classifyPageSnapshot(feedbackSnapshot(feedback, { weekVisible: false }), options), 'pending');
});

test('live CSV payload decoding is bounded and content-type closed', () => {
  assert.deepEqual(decodeCsvPayload({
    status: 'downloaded', name: 'Customer_Delivery_Feedback_negative_2026-W20.csv',
    type: 'text/csv; charset=utf-8', base64: csv.toString('base64'),
  }), csv);
  assert.throws(() => decodeCsvPayload({
    status: 'downloaded', name: 'Customer_Delivery_Feedback_negative_2026-W20.csv',
    type: 'text/html', base64: csv.toString('base64'),
  }), error => error.code === 'source_content_type_invalid');
  assert.throws(() => decodeCsvPayload({ status: 'source_too_large' }), error => error.code === 'source_too_large');
});

test('provider API data becomes deterministic exact-week auxiliary evidence', () => {
  const bytes = normalizeProviderPayload(providerPayload(), '2026-W20');
  assert.equal(validateProviderJson(bytes, '2026-W20').rowCount, 1);
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.equal(parsed.week, '2026-W20');
  assert.deepEqual(parsed.rows[0], {
    da_name: 'Fixture Driver', transporter_id: 'transporter-1', provider_id: 'amzn1.flex.provider.v1.12345678',
  });
  assert.throws(() => normalizeProviderPayload({
    status: 'downloaded', text: JSON.stringify({ tableData: { da_dsp_weekly_cdf: { rows: [{ da_name: 'Incomplete' }] } } }),
  }, '2026-W20'), error => error.code === 'provider_source_invalid');
});

test('weekly browser collection gets authoritative CSV and auxiliary provider evidence from one page', async () => {
  const connection = fakeConnection();
  const result = await collectWeeklyFromEndpoint('http://127.0.0.1:9555', request(), {
    connectPage: async () => connection,
  });
  assert.deepEqual(result.csvBytes, csv);
  assert.equal(validateProviderJson(result.providerBytes, '2026-W20').rowCount, 1);
  assert.equal(connection.closed, true);
});

test('provider failure degrades valid weekly CSV, while unavailable authoritative data fails', async () => {
  const degraded = fakeConnection({ provider: { status: 'provider_unavailable' } });
  const result = await collectWeeklyFromEndpoint('http://127.0.0.1:9555', request(), {
    connectPage: async () => degraded,
  });
  assert.deepEqual(result.csvBytes, csv);
  assert.equal(result.providerBytes, null);
  assert.equal(degraded.closed, true);

  const unavailable = fakeConnection({ unavailable: true });
  await assert.rejects(collectWeeklyFromEndpoint('http://127.0.0.1:9555', request(), {
    connectPage: async () => unavailable,
  }), error => error.code === 'week_unavailable');
  assert.equal(unavailable.closed, true);
});

test('CDF browser lease is released after success and failure', async () => {
  for (const shouldFail of [false, true]) {
    let released = 0;
    const lease = {
      endpoint: 'http://127.0.0.1:9555', protocol: 'cdp', access: 'full', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      async renew() {}, async status() {}, async release() { released += 1; },
    };
    const options = { authProfile: 'amazon-example', runId: `run_lease_${shouldFail}`, deadline: new Date(Date.now() + 60_000).toISOString() };
    if (shouldFail) {
      await assert.rejects(withCdfBrowser(options, async () => { throw Object.assign(new Error('week_unavailable'), { code: 'week_unavailable' }); }, {
        acquireBrowser: async () => lease,
      }), error => error.code === 'week_unavailable');
    } else {
      assert.equal(await withCdfBrowser(options, async browser => browser.endpoint, {
        acquireBrowser: async () => lease,
      }), lease.endpoint);
    }
    assert.equal(released, 1);
  }
});

test('CDF browser cancellation cannot return success and releases a late-acquired lease', async () => {
  for (const phase of ['acquisition', 'use', 'release']) {
    const controller = new AbortController();
    let released = false;
    let used = false;
    const lease = {
      endpoint: 'http://127.0.0.1:9555', protocol: 'cdp', access: 'full',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      async renew() {}, async status() {},
      async release() { released = true; if (phase === 'release') controller.abort(); },
    };
    const acquireBrowser = async ({ signal }) => {
      if (phase === 'acquisition') {
        controller.abort();
        assert.equal(signal.aborted, true);
      }
      return lease;
    };
    await assert.rejects(withCdfBrowser({
      authProfile: 'amazon-example', runId: `run_cancel_${phase}`,
      deadline: new Date(Date.now() + 60_000).toISOString(), signal: controller.signal,
    }, async () => {
      used = true;
      if (phase === 'use') controller.abort();
      return 'must-not-succeed';
    }, { acquireBrowser }), error => error.code === 'acquisition_cancelled');
    assert.equal(released, true);
    assert.equal(used, phase !== 'acquisition');
  }
});

test('CDF browser cleanup failure blocks both successful and failed source outcomes', async () => {
  for (const useFails of [false, true]) {
    const lease = {
      endpoint: 'http://127.0.0.1:9555', protocol: 'cdp', access: 'full', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      async renew() {}, async status() {},
      async release() { throw Object.assign(new Error('browser_cleanup_failed'), { code: 'browser_cleanup_failed' }); },
    };
    await assert.rejects(withCdfBrowser({
      authProfile: 'amazon-example', runId: `run_cleanup_${useFails}`, deadline: new Date(Date.now() + 60_000).toISOString(),
    }, async () => {
      if (useFails) throw Object.assign(new Error('week_unavailable'), { code: 'week_unavailable' });
      return null;
    }, { acquireBrowser: async () => lease }), error => error.code === 'browser_cleanup_failed');
  }
});

test('CDF browser acquisition reports its deadline timer even if wall time has not reached the deadline', async t => {
  // Advance only the timer: wall time can lag it or move backwards during acquisition.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = new Date(Date.now() + 60_000).toISOString();
  let acquisitionStarted;
  const started = new Promise(resolve => { acquisitionStarted = resolve; });
  const rejected = assert.rejects(withCdfBrowser({
    authProfile: 'amazon-example', runId: 'run_deadline_acquire', deadline,
  }, async () => assert.fail('an expired acquisition must not use the browser'), {
    acquireBrowser: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('acquisition_cancelled'), { code: 'acquisition_cancelled' })), { once: true });
      acquisitionStarted();
    }),
  }), error => error.code === 'deadline_exceeded');
  await started;
  t.mock.timers.tick(60_000);
  await rejected;
});

test('production weekly source binds one lease to one exact manager request', async () => {
  const calls = [];
  const currentRequest = request();
  const result = await collectWeeklyArtifacts(currentRequest, {
    withBrowser: async (options, use) => {
      calls.push(options);
      return use({ endpoint: 'http://127.0.0.1:9555', signal: null });
    },
    collectFromEndpoint: async (endpoint, current) => {
      assert.equal(endpoint, 'http://127.0.0.1:9555');
      assert.equal(current.input.week, '2026-W20');
      return { csvBytes: csv, providerBytes: null };
    },
  });
  assert.deepEqual(result, { csvBytes: csv, providerBytes: null });
  assert.deepEqual(calls[0], {
    authProfile: 'amazon-example', runId: 'run_weekly_source', deadline: currentRequest.deadline,
    signal: null,
  });
});
