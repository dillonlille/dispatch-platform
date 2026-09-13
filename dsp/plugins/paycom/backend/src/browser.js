'use strict';

const crypto = require('node:crypto');
const {
  CdpConnection, CdpError, createTarget, boundedJson,
} = require('dispatch-sdk/node/cdp');
const {
  buildTimecardUrl, canonicalTimecardUrl, isCapturedTimecardUrl, parsePeriodKey,
} = require('./timecard-period');
const { buildExtractionExpression, validateTimecardRecord } = require('./timecard-dom');
const { canonicalBusinessTimecard, timecardBusinessSha256 } = require('./fingerprints');

const TIMECARD_SEARCH_URL = 'https://www.paycomonline.net/v4/cl/web.php/timecardsearch/index?from=main_menu';
const ROSTER_API = 'https://time-and-attendance.paycomonline.net/api/cl/timecard-search/employees';
const MAX_SOURCE_BYTES = 2_097_152;
const TIMECARD_BLOCKED_URLS = Object.freeze([
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.ico',
  '*.woff', '*.woff2', '*.ttf', '*.otf', '*.mp3', '*.mp4', '*.webm',
]);
const TIMECARD_PHASES = Object.freeze(['navigate', 'response', 'load', 'body', 'ready', 'extract', 'validate']);
const DEFAULT_ITEM_TIMEOUT_MS = 120_000;
const ROSTER_REQUEST_FIELDS = Object.freeze([
  'allocationCategories', 'approvalMode', 'eeCodes', 'endDate', 'getCount', 'highlighting',
  'isAdvancedFilterApplied', 'loadTotals', 'minWageUrl', 'onlyBorrowedEmployees', 'payClassCodes',
  'q', 'selectedColumns', 'selectedEarnings', 'skip', 'sortParams', 'startDate', 'take',
]);

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function rosterApiUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'time-and-attendance.paycomonline.net'
      && !url.port && !url.username && !url.password && !url.hash
      && url.pathname === '/api/cl/timecard-search/employees' ? url : null;
  } catch { return null; }
}

function rosterRequest(value, period) {
  try {
    const request = value?.request;
    const url = rosterApiUrl(request.url);
    if (request.method !== 'POST' || !url || url.search !== '' || typeof value.requestId !== 'string') return null;
    const body = JSON.parse(request.postData);
    if (body.startDate !== period.start || body.endDate !== period.end || !Array.isArray(body.eeCodes)
        || body.eeCodes.length < 1 || body.eeCodes.length > 5000 || new Set(body.eeCodes).size !== body.eeCodes.length
        || body.eeCodes.some(code => typeof code !== 'string' || !/^[A-Za-z0-9]{4}$/.test(code))) return null;
    return { requestId: value.requestId, codes: body.eeCodes.map(code => code.toUpperCase()).sort() };
  } catch { return null; }
}

function emptyFilter(value) {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function rosterAuthorityAssessment(body) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype) {
    return { observable: false, authoritative: false, code: 'roster_source_not_authoritative' };
  }
  if (![false, true].includes(body.isAdvancedFilterApplied)) {
    return {
      observable: false,
      authoritative: false,
      code: body.isAdvancedFilterApplied === null
        ? 'roster_filter_advanced_null' : 'roster_filter_advanced_invalid',
    };
  }
  const hardChecks = [
    [body.q === null || body.q === '', 'roster_filter_search'],
    [body.onlyBorrowedEmployees === false, 'roster_filter_borrowed'],
    [body.skip === null || body.skip === 0, 'roster_filter_page_offset'],
    [body.take === null || (Number.isInteger(body.take) && body.take >= body.eeCodes.length), 'roster_filter_page_size'],
    [body.getCount === null || body.getCount === true, 'roster_filter_count'],
  ];
  const failed = hardChecks.find(([accepted]) => !accepted);
  if (failed) return { observable: false, authoritative: false, code: failed[1] };
  const softFiltersPresent = body.isAdvancedFilterApplied
    || !emptyFilter(body.payClassCodes) || !emptyFilter(body.selectedEarnings) || !emptyFilter(body.approvalMode);
  if (softFiltersPresent) {
    return { observable: true, authoritative: false, code: 'roster_filters_present' };
  }
  return { observable: true, authoritative: true, code: null };
}

function authoritativeRosterBody(body) {
  return rosterAuthorityAssessment(body).authoritative;
}

function fetchRosterRequest(value, period, { unfiltered = false } = {}) {
  try {
    const request = value?.request;
    const url = rosterApiUrl(request?.url);
    if (!url || url.search !== '' || request.method !== 'POST' || typeof value.requestId !== 'string'
        || Number.isInteger(value.responseStatusCode)) return null;
    const body = JSON.parse(request.postData);
    if (!body || Object.getPrototypeOf(body) !== Object.prototype
        || Object.keys(body).sort().join(',') !== [...ROSTER_REQUEST_FIELDS].sort().join(',')
        || typeof body.startDate !== 'string' || typeof body.endDate !== 'string'
        || !Array.isArray(body.eeCodes) || body.eeCodes.length < 1 || body.eeCodes.length > 5000
        || new Set(body.eeCodes).size !== body.eeCodes.length
        || body.eeCodes.some(code => typeof code !== 'string' || !/^[A-Za-z0-9]{4}$/.test(code))) return null;
    if (typeof unfiltered !== 'boolean') return null;
    // The saved Timecard Search view may apply pay-class/approval filters.
    // Collection requests the entire supplied employee list without changing
    // those saved UI preferences. Search/pagination/borrowed-only views still fail.
    const originalAuthority = rosterAuthorityAssessment(body);
    const selectedBody = unfiltered && originalAuthority.observable ? {
      ...body, isAdvancedFilterApplied: false, selectedEarnings: [], approvalMode: null,
    } : body;
    const authority = rosterAuthorityAssessment(selectedBody);
    const uiPeriod = parsePeriodKey(`${body.startDate}_${body.endDate}`);
    return {
      requestId: value.requestId,
      codes: body.eeCodes.map(code => code.toUpperCase()).sort(),
      observable: authority.observable,
      // Paycom requires the supplied pay-class list even when all requested
      // employees are wanted. Complete mode additionally requires an exact
      // response for every supplied employee code before it can be published.
      authoritative: authority.authoritative || unfiltered && originalAuthority.observable,
      authorityCode: authority.code,
      uiPeriod: { start: uiPeriod.start, end: uiPeriod.end },
      postData: Buffer.from(JSON.stringify({ ...selectedBody, startDate: period.start, endDate: period.end })).toString('base64'),
    };
  } catch { return null; }
}

function fetchRosterResponse(value) {
  try {
    const url = rosterApiUrl(value?.request?.url);
    const contentTypes = (value.responseHeaders || []).filter(header => String(header.name).toLowerCase() === 'content-type');
    return Boolean(url && url.search === '' && value.request.method === 'POST' && Number.isInteger(value.responseStatusCode)
      && value.responseStatusCode === 200 && contentTypes.length === 1
      && /^application\/json(?:;|$)/i.test(String(contentTypes[0].value)));
  } catch { return false; }
}

function rosterResponse(value, requestId) {
  try {
    const url = rosterApiUrl(value?.response?.url);
    return value.requestId === requestId && value.response.status === 200
      && String(value.response.mimeType || '').toLowerCase() === 'application/json'
      && url && url.search === '';
  } catch { return false; }
}

function rosterMembershipAssessment(bytes, codes) {
  try {
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(raw.eeCodes) || raw.eeCodes.length < 1 || raw.eeCodes.length > 5000) return null;
    const returned = raw.eeCodes.map(code => String(code).toUpperCase()).sort();
    if (new Set(returned).size !== returned.length || returned.some(code => !/^[A-Z0-9]{4}$/.test(code))) return null;
    const requested = new Set(codes);
    if (returned.some(code => !requested.has(code))) return null;
    return {
      exact: returned.length === codes.length && returned.every((code, index) => code === codes[index]),
      returnedCount: returned.length,
    };
  } catch { return null; }
}

function rosterMembership(bytes, codes) {
  return rosterMembershipAssessment(bytes, codes)?.exact === true;
}

function rosterReadExpression({ headers, body }) {
  // The destination is fixed; redirects cannot forward captured session headers.
  return `(${async function read(input) {
    try {
      const response = await fetch(input.url, { method: 'POST', credentials: 'include',
        redirect: 'error', cache: 'no-store', headers: input.headers, body: input.body,
        signal: AbortSignal.timeout(55_000) });
      if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')
          || !response.body) return { status: response.status, error: 'invalid_response' };
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, text = '';
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > input.maximum) { await reader.cancel(); return { status: 0, error: 'too_large' }; }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      return { status: response.status, text };
    } catch (error) {
      return { status: 0, error: ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'request_failed' };
    }
  }})(${JSON.stringify({ url: ROSTER_API, headers, body, maximum: MAX_SOURCE_BYTES })})`;
}

async function collectRoster(endpoint, periodValue, options = {}) {
  const period = parsePeriodKey(periodValue.key);
  // The handoff page can still issue startup requests. Intercepting it before
  // navigating can select a request from the discarded document. A blank page
  // shares this lease's authentication while keeping capture scoped to its own navigation.
  const target = await createTarget(endpoint, 'about:blank');
  let connection = null;
  let requestPause = null;
  let selectedRequestId = null;
  const continueOtherRequests = event => {
    let value;
    try { value = JSON.parse(event.data); } catch { return; }
    const paused = value.params;
    if (value.method !== 'Fetch.requestPaused' || !rosterApiUrl(paused?.request?.url)
        || Number.isInteger(paused.responseStatusCode)) return;
    if (paused.request.method === 'POST' && selectedRequestId === null) {
      selectedRequestId = paused.requestId;
      return;
    }
    // Other startup/preflight requests can be dependencies of the selected call.
    if (paused.requestId !== selectedRequestId)
      connection.command('Fetch.continueRequest', { requestId: paused.requestId }).catch(() => {});
  };
  try {
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { commandTimeoutMs: 60_000 });
    connection.socket.addEventListener('message', continueOtherRequests);
    await connection.command('Page.enable');
    await connection.command('Fetch.enable', { patterns: [{ urlPattern: ROSTER_API, requestStage: 'Request' }] });
    const requestPromise = connection.waitFor('Fetch.requestPaused', value => value?.request?.method === 'POST'
      && rosterApiUrl(value.request.url) !== null && !Number.isInteger(value.responseStatusCode), 60_000);
    requestPromise.catch(() => {});
    const navigation = await connection.command('Page.navigate', { url: TIMECARD_SEARCH_URL });
    if (navigation.errorText) fail('navigation_failed');
    try { requestPause = await requestPromise; }
    catch (error) { if (error instanceof CdpError && error.code === 'browser_timeout') fail('roster_request_timeout'); throw error; }
    const request = fetchRosterRequest(requestPause, period, options);
    if (!request) {
      if (rosterApiUrl(requestPause?.request?.url)?.search) fail('roster_request_url_mismatch');
      fail('roster_period_mismatch');
    }
    const headers = Object.fromEntries(Object.entries(requestPause.request.headers || {})
      .filter(([key]) => /^(accept|authorization|content-type|x-xsrf-token|x-csrf-token|x-requested-with)$/i.test(key)));
    if (!Object.values(headers).every(value => typeof value === 'string' && value.length <= 16_384
        && !/[\r\n]/.test(value))) fail('roster_request_url_mismatch');
    // Release the page's original request, then make our own bounded read using
    // its session headers. Startup requests can otherwise replace the captured
    // period or return a cached response for the saved UI period.
    await connection.command('Fetch.continueRequest', { requestId: requestPause.requestId });
    requestPause = null;
    await connection.command('Fetch.disable');
    const result = await connection.evaluate(rosterReadExpression({
      headers, body: Buffer.from(request.postData, 'base64').toString('utf8'),
    }));
    if (result?.error === 'timeout') fail('roster_response_timeout');
    if (result?.status !== 200 || typeof result.text !== 'string') fail('roster_response_invalid');
    const bytes = Buffer.from(result.text, 'utf8');
    const membership = bytes.length >= 32 && bytes.length <= MAX_SOURCE_BYTES
      ? rosterMembershipAssessment(bytes, request.codes) : null;
    if (!membership) fail('roster_membership_mismatch');
    return {
      bytes,
      sourceSha256: sha256(bytes),
      completeness: {
        observable: request.observable,
        authoritative: request.authoritative && membership.exact,
        authorityCode: membership.exact ? (request.authoritative ? null : request.authorityCode) : 'roster_membership_subset',
        requestedCount: request.codes.length,
        returnedCount: membership.returnedCount,
      },
      uiPeriod: request.uiPeriod,
    };
  } catch (error) {
    if (error instanceof CdpError && error.code === 'browser_timeout') fail('paycom_timeout');
    throw error;
  } finally {
    connection?.socket.removeEventListener('message', continueOtherRequests);
    if (requestPause) try { await connection.command('Fetch.continueRequest', { requestId: requestPause.requestId }); } catch {}
    if (connection) try { await connection.command('Fetch.disable'); } catch {}
    connection?.close();
    try { await boundedJson(`${endpoint}/json/close/${encodeURIComponent(target.id)}`); } catch {}
  }
}

function timecardResponse(value, targetUrl) {
  return Boolean(value?.type === 'Document' && value.response?.url === targetUrl && value.response.status === 200
    && String(value.response.mimeType || '').toLowerCase() === 'text/html');
}

async function openTimecardSession(endpoint, clock = () => performance.now(), signal = null) {
  if (typeof clock !== 'function' || signal !== null && !(signal instanceof AbortSignal)) fail('invalid_collection');
  const target = await createTarget(endpoint, 'about:blank');
  let connection = null;
  try {
    connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { commandTimeoutMs: 60_000, signal });
    await connection.command('Page.enable');
    await connection.command('Page.setLifecycleEventsEnabled', { enabled: true });
    await connection.command('Network.enable');
    try { await connection.command('Network.setBlockedURLs', { urls: [...TIMECARD_BLOCKED_URLS] }); } catch {}
    return {
      async collect(employee, period, variant = 1, onTiming = () => {}) {
        if (typeof onTiming !== 'function') fail('invalid_collection');
        const targetUrl = buildTimecardUrl(employee.employeeCode, period, variant);
        if (!isCapturedTimecardUrl(targetUrl, { employeeCode: employee.employeeCode, period })) fail('navigation_policy_violation');
        try {
          const responsePromise = connection.waitFor('Network.responseReceived', value => timecardResponse(value, targetUrl), 120_000);
          responsePromise.catch(() => {});
          const navigateStarted = clock();
          const navigation = await connection.command('Page.navigate', { url: targetUrl });
          const navigateFinished = clock();
          if (navigation.errorText || typeof navigation.loaderId !== 'string') fail('navigation_failed');
          const response = await responsePromise;
          const responseFinished = clock();
          await connection.waitFor('Network.loadingFinished', value => value.requestId === response.requestId, 120_000);
          await connection.waitFor('Page.lifecycleEvent', value => value.loaderId === navigation.loaderId && value.name === 'load', 60_000);
          const loadFinished = clock();
          const body = await connection.command('Network.getResponseBody', { requestId: response.requestId });
          if (typeof body?.body !== 'string') fail('timecard_body_unavailable');
          const sourceHtml = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
          if (sourceHtml.length < 1024 || sourceHtml.length > MAX_SOURCE_BYTES
              || !sourceHtml.includes(Buffer.from('id="tbltimesheet"')) || !sourceHtml.includes(Buffer.from('id="periodtotals"'))) fail('timecard_html_invalid');
          const bodyFinished = clock();
          let ready = false;
          for (let index = 0; index < 60; index++) {
            ready = await connection.evaluate("document.readyState==='complete'&&!!document.querySelector('#tbltimesheet')&&!!document.querySelector('#periodtotals')");
            if (ready) break;
            await delay(100);
          }
          if (!ready) fail('timecard_page_timeout');
          const readyFinished = clock();
          const capturedRecord = await connection.evaluate(buildExtractionExpression({ employeeCode: employee.employeeCode, period, sourceUrl: targetUrl }));
          const extractFinished = clock();
          validateTimecardRecord(capturedRecord, { employeeCode: employee.employeeCode, period, sourceUrl: targetUrl });
          const record = canonicalBusinessTimecard(capturedRecord);
          const sourceUrl = canonicalTimecardUrl(employee.employeeCode, period);
          validateTimecardRecord(record, { employeeCode: employee.employeeCode, period, sourceUrl });
          const sourceSha256 = sha256(sourceHtml);
          const businessSha256 = timecardBusinessSha256(record);
          const observedAt = new Date().toISOString();
          const validateFinished = clock();
          onTiming({
            navigateMs: navigateFinished - navigateStarted,
            responseMs: responseFinished - navigateFinished,
            loadMs: loadFinished - responseFinished,
            bodyMs: bodyFinished - loadFinished,
            readyMs: readyFinished - bodyFinished,
            extractMs: extractFinished - readyFinished,
            validateMs: validateFinished - extractFinished,
          });
          return {
            employeeCode: employee.employeeCode,
            employeeName: employee.employeeName,
            record,
            sourceSha256,
            businessSha256,
            observedAt,
          };
        } catch (error) {
          if (error instanceof CdpError && error.code === 'browser_timeout') fail('paycom_timeout');
          throw error;
        }
      },
      async close() {
        try { await connection.command('Network.disable'); } catch {}
        connection.close();
        try { await boundedJson(`${endpoint}/json/close/${encodeURIComponent(target.id)}`); } catch {}
      },
    };
  } catch (error) {
    connection?.close();
    try { await boundedJson(`${endpoint}/json/close/${encodeURIComponent(target.id)}`); } catch {}
    throw error;
  }
}

async function collectOneTimecard(endpoint, employee, period, variant = 1) {
  const session = await openTimecardSession(endpoint);
  try { return await session.collect(employee, period, variant); }
  finally { await session.close(); }
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round(ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)]);
}

function phaseMetrics(samples) {
  const result = {};
  for (const phase of ['targetOpen', ...TIMECARD_PHASES]) {
    const values = samples[phase];
    result[`${phase}P50Ms`] = percentile(values, 0.5);
    result[`${phase}P95Ms`] = percentile(values, 0.95);
    result[`${phase}MaxMs`] = percentile(values, 1);
  }
  return result;
}

async function collectTimecards(endpoint, employees, periodValue, concurrency = 3, onProgress = () => {}, options = {}) {
  const period = parsePeriodKey(periodValue.key);
  if (!Array.isArray(employees) || employees.length < 1 || employees.length > 5000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6
      || typeof onProgress !== 'function' || !options || typeof options !== 'object' || Array.isArray(options)) fail('invalid_collection');
  const clock = options.clock || (() => performance.now());
  const itemTimeoutMs = options.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
  const openSession = options.openSession || ((workerIndex, signal) => openTimecardSession(endpoint, clock, signal));
  if (typeof openSession !== 'function' || typeof clock !== 'function'
      || !Number.isInteger(itemTimeoutMs) || itemTimeoutMs < 10 || itemTimeoutMs > DEFAULT_ITEM_TIMEOUT_MS) fail('invalid_collection');
  const started = clock();
  const results = Array(employees.length);
  const itemDurations = [];
  const phaseSamples = Object.fromEntries(['targetOpen', ...TIMECARD_PHASES].map(phase => [phase, []]));
  let next = 0;
  let completed = 0;
  let retries = 0;
  let openedTargets = 0;
  let cancelled = false;
  let firstError = null;
  const activeControllers = new Set();
  const cancelWorkers = () => {
    cancelled = true;
    for (const controller of activeControllers) controller.abort();
  };
  async function worker(workerIndex) {
    let session = null;
    let sessionController = null;
    const closeSession = async () => {
      if (!session) {
        if (sessionController) activeControllers.delete(sessionController);
        sessionController = null;
        return;
      }
      const current = session;
      const controller = sessionController;
      session = null;
      sessionController = null;
      if (controller) activeControllers.delete(controller);
      try { await current.close(); } catch {}
    };
    try {
      while (!cancelled) {
        const index = next++;
        if (index >= employees.length) return;
        const itemStarted = clock();
        let last;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (!session) {
              const openStarted = clock();
              sessionController = new AbortController();
              activeControllers.add(sessionController);
              try { session = await openSession(workerIndex, sessionController.signal); }
              catch (error) {
                activeControllers.delete(sessionController);
                sessionController = null;
                throw error;
              }
              phaseSamples.targetOpen.push(Math.max(0, clock() - openStarted));
              openedTargets += 1;
            }
            let timeout = null;
            let itemTimedOut = false;
            const collected = session.collect(employees[index], period, (workerIndex + attempt) % 2 + 1, timing => {
              if (!timing || typeof timing !== 'object' || Array.isArray(timing)
                  || Object.keys(timing).sort().join(',') !== TIMECARD_PHASES.map(phase => `${phase}Ms`).sort().join(',')) fail('invalid_collection');
              const values = {};
              for (const phase of TIMECARD_PHASES) {
                const value = timing[`${phase}Ms`];
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 120_000) fail('invalid_collection');
                values[phase] = value;
              }
              for (const phase of TIMECARD_PHASES) phaseSamples[phase].push(values[phase]);
            });
            collected.catch(() => {});
            try {
              const timedOut = new Promise((resolve, reject) => {
                timeout = setTimeout(() => {
                  itemTimedOut = true;
                  sessionController?.abort();
                  reject(Object.assign(new Error('timecard_item_timeout'), { code: 'timecard_item_timeout' }));
                }, itemTimeoutMs);
              });
              try { results[index] = await Promise.race([collected, timedOut]); }
              catch (error) {
                if (itemTimedOut) fail('timecard_item_timeout');
                throw error;
              }
            } finally {
              clearTimeout(timeout);
            }
            completed += 1;
            itemDurations.push(Math.max(0, clock() - itemStarted));
            onProgress(completed, employees.length);
            last = null;
            break;
          } catch (error) {
            last = error;
            await closeSession();
            const code = error?.code || error?.message;
            if (!['paycom_timeout', 'timecard_body_unavailable', 'timecard_page_timeout', 'timecard_item_timeout'].includes(code) || attempt === 1 || cancelled) {
              if (!firstError) firstError = error;
              cancelWorkers();
              return;
            }
            retries += 1;
            await delay(250 * (attempt + 1));
          }
        }
        if (last) {
          if (!firstError) firstError = last;
          cancelWorkers();
          return;
        }
      }
    } finally {
      await closeSession();
    }
  }
  const workerCount = Math.min(concurrency, employees.length);
  await Promise.allSettled(Array.from({ length: workerCount }, (_, index) => worker(index)));
  if (firstError) throw firstError;
  return {
    rows: results,
    performance: {
      totalMs: Math.round(Math.max(0, clock() - started)),
      itemCount: results.length,
      workerCount,
      openedTargets,
      retryCount: retries,
      itemP50Ms: percentile(itemDurations, 0.5),
      itemP95Ms: percentile(itemDurations, 0.95),
      itemMaxMs: percentile(itemDurations, 1),
      ...phaseMetrics(phaseSamples),
    },
  };
}

module.exports = {
  TIMECARD_SEARCH_URL, ROSTER_API, ROSTER_REQUEST_FIELDS, rosterReadExpression,
  rosterApiUrl, rosterRequest, rosterAuthorityAssessment, authoritativeRosterBody, fetchRosterRequest, fetchRosterResponse, rosterResponse,
  rosterMembershipAssessment, rosterMembership,
  collectRoster, collectOneTimecard, collectTimecards,
};
