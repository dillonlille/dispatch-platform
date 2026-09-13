'use strict';
const { AccessError } = require('../accounts/src/validation');
const SERVER_OPTIONS = Object.freeze({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000,
  headersTimeout: 10_000, keepAliveTimeout: 5_000 });
const DEFAULT_SYNC_ID = 'paycom-main-workforce';
const MAX_BODY_BYTES = 8192;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PUBLIC_STATUS_RE = /^[a-z][a-z0-9_]{0,63}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const LOCAL_REQUEST_ERRORS = new Set(['invalid_input', 'invalid_json', 'request_too_large']);

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function checkedPublicOrigin(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError('dashboard_dependencies_required');
  let selected;
  try { selected = new URL(value); } catch { throw new TypeError('dashboard_dependencies_required'); }
  if (selected.protocol !== 'https:' || selected.origin !== value
      || selected.pathname !== '/' || selected.username || selected.password || selected.search || selected.hash) {
    throw new TypeError('dashboard_dependencies_required');
  }
  return selected;
}

function requirePublicRequest(request, publicOrigin) {
  if (!publicOrigin) return;
  const host = request.headers.host;
  if (typeof host !== 'string' || host !== publicOrigin.host) {
    throw new AccessError('request_forbidden', 403);
  }
  let visitor;
  try { visitor = JSON.parse(request.headers['cf-visitor']); } catch { visitor = null; }
  if (!plain(visitor) || Object.keys(visitor).length !== 1 || !['http', 'https'].includes(visitor.scheme)) {
    throw new AccessError('request_forbidden', 403);
  }
  if (visitor.scheme === 'http') {
    if (!SAFE_METHODS.has(request.method)) throw new AccessError('request_forbidden', 403);
    const redirect = new URL(request.url, publicOrigin);
    if (redirect.origin !== publicOrigin.origin) throw new AccessError('request_forbidden', 403);
    return redirect.href;
  }
  if (!SAFE_METHODS.has(request.method) && request.headers.origin !== publicOrigin.origin) {
    throw new AccessError('request_forbidden', 403);
  }
  return null;
}

function boundedText(value, fallback, maximum = 120) {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'string' || selected.length < 1 || selected.length > maximum || /[\0\r\n]/.test(selected)) {
    throw new TypeError('dashboard_config_invalid');
  }
  return selected;
}

function dashboardConfig(environment = process.env) {
  const timezone = boundedText(environment.DISPATCH_DASHBOARD_TIMEZONE, 'America/Los_Angeles', 64);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw new TypeError('dashboard_config_invalid'); }
  return Object.freeze({
    organization: Object.freeze({
      id: 'local-dsp',
      name: boundedText(environment.DISPATCH_DASHBOARD_DSP_NAME, 'Example Delivery LLC'),
    }),
    site: Object.freeze({
      id: 'local-site',
      code: boundedText(environment.DISPATCH_DASHBOARD_STATION, 'TST1', 32),
    }),
    timezone,
    syncId: boundedText(environment.DISPATCH_DASHBOARD_SYNC_ID, DEFAULT_SYNC_ID, 64),
  });
}

function sourceDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function securityHeaders(contentType = null) {
  return {
    ...(contentType ? { 'Content-Type': contentType } : {}),
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(response, statusCode, value, headers = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(statusCode, {
    ...securityHeaders('application/json; charset=utf-8'),
    'Cache-Control': 'no-store',
    'Content-Length': bytes.length,
    ...headers,
  });
  response.end(bytes);
}

async function readJson(request, maximumBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw Object.assign(new Error('request_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_json'), { statusCode: 400 }); }
  if (!plain(value)) throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  return value;
}

function integerParameter(value, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw Object.assign(new Error('invalid_input'), { statusCode: 400 });
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw Object.assign(new Error('invalid_input'), { statusCode: 400 });
  }
  return result;
}

function dailyQuery(searchParams) {
  const allowed = new Set(['date', 'search', 'attention', 'lifecycleStatus', 'limit', 'offset', 'sort', 'direction', 'department', 'station']);
  if ([...searchParams.keys()].some(key => !allowed.has(key)) || searchParams.getAll('date').length !== 1) {
    throw Object.assign(new Error('invalid_input'), { statusCode: 400 });
  }
  const date = searchParams.get('date');
  if (!DATE_RE.test(date || '')) throw Object.assign(new Error('invalid_input'), { statusCode: 400 });
  const optional = key => {
    const values = searchParams.getAll(key);
    if (values.length > 1) throw Object.assign(new Error('invalid_input'), { statusCode: 400 });
    return values.length === 0 || values[0] === '' ? undefined : values[0];
  };
  const query = {
    date,
    ...(optional('department') === undefined ? {} : {department:optional('department')}),
    ...(optional('station') === undefined ? {} : {station:optional('station')}),
    ...(optional('sort') === undefined ? {} : { sort: optional('sort') }),
    ...(optional('direction') === undefined ? {} : { direction: optional('direction') }),
    ...(optional('search') === undefined ? {} : { search: optional('search') }),
    ...(optional('attention') === undefined ? {} : { attention: optional('attention') }),
    ...(optional('lifecycleStatus') === undefined ? {} : { lifecycleStatus: optional('lifecycleStatus') }),
    limit: integerParameter(optional('limit') ?? null, 100, { minimum: 1, maximum: 100 }),
    offset: integerParameter(optional('offset') ?? null, 0),
  };
  try { require('../../shared/contracts/src/workforce').workforceDayQuery(query); }
  catch { throw new AccessError('invalid_input', 400); }
  return query;
}

function publicSdkFailure(result, fallback) {
  const status = typeof result?.status === 'string' && PUBLIC_STATUS_RE.test(result.status)
    ? result.status : fallback;
  if (!plain(result?.error) || result.error.code !== status) {
    return { code: fallback, recoverable: false };
  }
  return { code: status, recoverable: result.error.recoverable === true };
}

function publicSdkResult(result, fallback) {
  if (result?.ok === true) return result;
  const error = publicSdkFailure(result, fallback);
  return { contractVersion: 1, ok: false, status: error.code, error, data: null };
}

function publicHttpFailure(error) {
  const claimed = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const statusCode = claimed >= 400 && claimed <= 599 ? claimed : 500;
  // These expected availability failures contain no private diagnostic data.
  // Keep every other server failure opaque, including untrusted lookalike errors.
  if (statusCode === 503 && error instanceof AccessError
      && ['release_worker_unavailable', 'installation_operator_disabled', 'invitation_email_unavailable', 'turnstile_unavailable', 'password_recovery_unavailable', 'password_recovery_busy'].includes(error.code)) {
    return { statusCode, code: error.code };
  }
  if (statusCode >= 500) return { statusCode, code: 'dashboard_unavailable' };
  if (error instanceof AccessError && typeof error.code === 'string' && PUBLIC_STATUS_RE.test(error.code)) {
    return { statusCode, code: error.code };
  }
  const code = typeof error?.message === 'string' && LOCAL_REQUEST_ERRORS.has(error.message)
    ? error.message : 'invalid_input';
  return { statusCode, code };
}

function publicSyncView(result) {
  if (!result?.ok || !plain(result.data)) {
    const error = publicSdkFailure(result, 'sync_unavailable');
    return { ok: false, status: error.code, error, data: null };
  }
  return {
    ok: true,
    status: result.status,
    error: null,
    data: {
      id: result.data.id,
      desiredState: result.data.desiredState,
      activity: result.data.activity,
      lastSucceededAt: result.data.lastSucceededAt,
      nextDueAt: result.data.nextDueAt,
      lastError: result.data.lastError,
      businessContext: result.data.businessContext,
      alerts: result.data.alerts,
      activeRun: result.data.activeRun,
      queuedRunCount: result.data.queuedRunCount,
      queuedRequest: result.data.queuedRequest || null,
    },
  };
}


module.exports = { SERVER_OPTIONS, DEFAULT_SYNC_ID, IDEMPOTENCY_RE, dashboardConfig, sourceDate, dailyQuery, publicSyncView, publicSdkFailure, publicSdkResult, publicHttpFailure, integerParameter, readJson, sendJson, securityHeaders, checkedPublicOrigin, requirePublicRequest };
