'use strict';
const {parsePeriodKey}=require('./timecard-period');
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


module.exports={ROSTER_API,TIMECARD_SEARCH_URL,fetchRosterRequest,rosterReadExpression,rosterMembership};
