'use strict';

const {
  CdpConnection, CdpError, boundedJson, validateTarget,
} = require('../../../runtime/auth-broker/src/cdp');
const { periodFromWeek } = require('./periods');
const { canonicalStringify, plain, validateCsv, validateProviderJson } = require('./validation');
const { withCdfBrowser } = require('./authenticated-browser');

const AUTHENTICATED_URL = 'https://logistics.amazon.com/operations/execution';
const PERFORMANCE_ORIGIN = 'https://logistics.amazon.com';
const PERFORMANCE_PATH = '/performance';
const PROVIDER_API_PATH = '/performance/api/v1/getData';
const MAX_LIVE_CSV_BYTES = 2_097_152;
const MAX_LIVE_PROVIDER_BYTES = 1_048_576;
const PAGE_TIMEOUT_MS = 90_000;
const QUALITY_TIMEOUT_MS = 60_000;
const ALLOWED_CSV_TYPES = Object.freeze([
  'text/csv', 'application/csv', 'text/plain', 'application/octet-stream',
  'binary/octet-stream', 'application/vnd.ms-excel',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail('acquisition_cancelled');
}

function assertCurrent(deadline, signal, now = Date.now()) {
  if (typeof deadline !== 'string' || Number.isNaN(Date.parse(deadline)) || now >= Date.parse(deadline)) fail('deadline_exceeded');
  throwIfAborted(signal);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    try { throwIfAborted(signal); } catch (error) { reject(error); return; }
    const timer = setTimeout(done, ms);
    function done() { cleanup(); resolve(); }
    function aborted() { cleanup(); try { throwIfAborted(signal); } catch (error) { reject(error); } }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function strictUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null;
    return url;
  } catch { return null; }
}

function exactQuery(url, expected) {
  const keys = [...url.searchParams.keys()];
  const expectedKeys = [...expected.searchParams.keys()];
  return keys.length === expectedKeys.length && new Set(keys).size === keys.length
    && expectedKeys.every(key => url.searchParams.get(key) === expected.searchParams.get(key));
}

function exactUrl(value, expectedValue) {
  const url = strictUrl(value);
  const expected = strictUrl(expectedValue);
  return Boolean(url && expected && url.origin === expected.origin && url.pathname === expected.pathname && exactQuery(url, expected));
}

function buildFeedbackUrl({ week, station, companyId }) {
  periodFromWeek(week);
  const url = new URL(PERFORMANCE_PATH, PERFORMANCE_ORIGIN);
  url.search = new URLSearchParams({
    pageId: 'dsp_customer_delivery_feedback_negative',
    station,
    companyId,
    tabId: 'customer-delivery-feedback-weekly-tab',
    timeFrame: 'Weekly',
    to: week,
  }).toString();
  return url.toString();
}

function buildQualityUrl({ week, station, companyId }) {
  periodFromWeek(week);
  const url = new URL(PERFORMANCE_PATH, PERFORMANCE_ORIGIN);
  url.search = new URLSearchParams({
    pageId: 'dsp_quality',
    station,
    companyId,
    tabId: 'quality-dsp-weekly-tab',
    timeFrame: 'Weekly',
    to: week,
  }).toString();
  return url.toString();
}

function buildProviderApiUrl({ week, station, dsp }) {
  periodFromWeek(week);
  const url = new URL(PROVIDER_API_PATH, PERFORMANCE_ORIGIN);
  url.search = new URLSearchParams({
    dataSetId: 'da_dsp_weekly_cdf',
    dsp,
    from: week,
    station,
    timeFrame: 'Weekly',
    to: week,
  }).toString();
  return url.toString();
}

function approvedDownloadUrl(value) {
  const url = strictUrl(value);
  return Boolean(url && url.hostname === 'logistics.amazon.com' && !url.search
    && /^\/performance\/downloads\/Customer_Delivery_Feedback_negative[A-Za-z0-9._-]*\.csv$/i.test(url.pathname));
}

function pageSnapshotExpression({ expectedUrl, week, kind }) {
  const weekNumber = Number(week.slice(-2));
  return `(()=>{
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    const body=String(document.body&&document.body.innerText||'');
    const normalized=body.replace(/\\s+/g,' ').trim();
    const lower=normalized.toLowerCase();
    const links=Array.from(document.querySelectorAll('a[download]')).filter(visible)
      .filter(a=>/Customer_Delivery_Feedback_negative.*\\.csv$/i.test(String(a.download||'')))
      .map(a=>({name:String(a.download||'').slice(0,240),href:String(a.href||'').slice(0,2048)}));
    return {
      url:location.href,
      readyState:document.readyState,
      authenticationRequired:visible(document.querySelector('#ap_email,#ap_password,input[name="email"],input[name="password"]'))||/sign in|enter your password/.test(lower),
      challengePresent:visible(document.querySelector('#auth-captcha-guess,#input-box-otp,#cvf-input-code,input[name="otpCode"]'))||/captcha|robot check|verify your identity|one[- ]time password|verification code/.test(lower),
      unavailable:/do not have data for this time/i.test(normalized),
      feedbackReady:/Customer Delivery Negative Feedback/i.test(normalized),
      qualityReady:/Quality Dashboard/i.test(normalized)||/Quality Dashboard/i.test(String(document.title||'')),
      weekVisible:normalized.includes(${JSON.stringify(week)})||new RegExp('Week\\\\s+0?${weekNumber}(?:\\\\s|,|$)','i').test(normalized),
      links:${JSON.stringify(kind)}==='feedback'?links:[]
    };
  })()`;
}

function classifyPageSnapshot(snapshot, { expectedUrl, kind }) {
  if (!plain(snapshot) || typeof snapshot.url !== 'string' || typeof snapshot.readyState !== 'string') return 'source_page_invalid';
  if (snapshot.challengePresent === true) return 'manual_verification_required';
  if (snapshot.authenticationRequired === true) return 'authentication_required';
  if (!exactUrl(snapshot.url, expectedUrl)) return snapshot.readyState === 'complete' ? 'source_page_invalid' : 'pending';
  if (kind === 'feedback' && snapshot.unavailable === true) return 'week_unavailable';
  if (kind === 'feedback' && snapshot.feedbackReady === true && snapshot.weekVisible === true
      && Array.isArray(snapshot.links) && snapshot.links.length === 1) return 'ready';
  if (kind === 'quality' && snapshot.qualityReady === true) return 'ready';
  return 'pending';
}

async function waitForPage(connection, options, {
  timeoutMs, signal, deadline, clock = Date.now, sleep = delay,
}) {
  const stopAt = Math.min(clock() + timeoutMs, Date.parse(deadline));
  while (clock() < stopAt) {
    assertCurrent(deadline, signal, clock());
    const snapshot = await connection.evaluate(pageSnapshotExpression(options));
    const state = classifyPageSnapshot(snapshot, options);
    if (state === 'ready') return snapshot;
    if (state !== 'pending') fail(state);
    await sleep(500, signal);
  }
  assertCurrent(deadline, signal, clock());
  fail('source_page_timeout');
}

function downloadExpression(expectedUrl) {
  return `(async()=>{
    const expected=${JSON.stringify(expectedUrl)},maximum=${MAX_LIVE_CSV_BYTES};
    const same=(left,right)=>{try{const a=new URL(left),b=new URL(right),ak=Array.from(a.searchParams.keys()),bk=Array.from(b.searchParams.keys());return a.protocol==='https:'&&!a.port&&!a.username&&!a.password&&!a.hash&&a.origin===b.origin&&a.pathname===b.pathname&&ak.length===bk.length&&new Set(ak).size===ak.length&&bk.every(k=>a.searchParams.get(k)===b.searchParams.get(k))}catch{return false}};
    const approved=value=>{try{const u=new URL(value),prefix='/performance/downloads/';return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&!u.hash&&!u.search&&u.hostname==='logistics.amazon.com'&&u.pathname.startsWith(prefix)&&/^Customer_Delivery_Feedback_negative[A-Za-z0-9._-]*\\.csv$/i.test(u.pathname.slice(prefix.length))}catch{return false}};
    if(!same(location.href,expected))return {status:'source_page_invalid'};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    const links=Array.from(document.querySelectorAll('a[download]')).filter(visible).filter(a=>/Customer_Delivery_Feedback_negative.*\\.csv$/i.test(String(a.download||''))&&approved(a.href));
    if(links.length!==1)return {status:'download_unavailable'};
    let response;try{response=await fetch(links[0].href,{credentials:'include',redirect:'error'})}catch{return {status:'download_unavailable'}};
    if(!response.ok||!approved(response.url)||!same(response.url,links[0].href))return {status:'download_unavailable'};
    const length=Number(response.headers.get('content-length')||0);
    if(Number.isFinite(length)&&length>maximum)return {status:'source_too_large'};
    const reader=response.body&&response.body.getReader();if(!reader)return {status:'download_unavailable'};
    const chunks=[];let total=0;
    while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>maximum){try{await reader.cancel()}catch{}return {status:'source_too_large'}}chunks.push(part.value)}
    if(total<1)return {status:'source_download_invalid'};
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
    let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return {status:'downloaded',name:String(links[0].download||'').slice(0,240),type:String(response.headers.get('content-type')||'').slice(0,160),base64:btoa(binary)};
  })()`;
}

function decodeCsvPayload(payload) {
  if (!plain(payload) || typeof payload.status !== 'string') fail('source_download_invalid');
  if (payload.status !== 'downloaded') fail([
    'download_unavailable', 'source_too_large', 'source_page_invalid', 'source_download_invalid',
  ].includes(payload.status) ? payload.status : 'source_download_invalid');
  if (Object.keys(payload).sort().join(',') !== 'base64,name,status,type'
      || typeof payload.name !== 'string' || payload.name.length > 240
      || !/^Customer_Delivery_Feedback_negative.*\.csv$/i.test(payload.name)
      || typeof payload.type !== 'string' || payload.type.length > 160
      || typeof payload.base64 !== 'string' || payload.base64.length > Math.ceil(MAX_LIVE_CSV_BYTES / 3) * 4 + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.base64)) fail('source_download_invalid');
  const type = payload.type.split(';', 1)[0].trim().toLowerCase();
  if (!ALLOWED_CSV_TYPES.includes(type)) fail('source_content_type_invalid');
  const bytes = Buffer.from(payload.base64, 'base64');
  if (bytes.length < 1 || bytes.length > MAX_LIVE_CSV_BYTES
      || bytes.toString('base64') !== payload.base64) fail('source_download_invalid');
  return bytes;
}

function providerFetchExpression({ qualityUrl, apiUrl }) {
  return `(async()=>{
    const expected=${JSON.stringify(qualityUrl)},api=${JSON.stringify(apiUrl)},maximum=${MAX_LIVE_PROVIDER_BYTES};
    const same=(left,right)=>{try{const a=new URL(left),b=new URL(right),ak=Array.from(a.searchParams.keys()),bk=Array.from(b.searchParams.keys());return a.protocol==='https:'&&!a.port&&!a.username&&!a.password&&!a.hash&&a.origin===b.origin&&a.pathname===b.pathname&&ak.length===bk.length&&new Set(ak).size===ak.length&&bk.every(k=>a.searchParams.get(k)===b.searchParams.get(k))}catch{return false}};
    if(!same(location.href,expected))return {status:'source_page_invalid'};
    const target=new URL(api);if(target.origin!=='https://logistics.amazon.com'||target.pathname!=='/performance/api/v1/getData')return {status:'provider_source_invalid'};
    let response;try{response=await fetch(api,{credentials:'include',redirect:'error'})}catch{return {status:'provider_unavailable'}};
    if(response.status===401||response.status===403)return {status:'authentication_required'};
    if(!response.ok||!same(response.url,api))return {status:'provider_unavailable'};
    const type=String(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase();
    if(type!=='application/json')return {status:'provider_source_invalid'};
    const length=Number(response.headers.get('content-length')||0);
    if(Number.isFinite(length)&&length>maximum)return {status:'provider_unavailable'};
    const reader=response.body&&response.body.getReader();if(!reader)return {status:'provider_unavailable'};
    const chunks=[];let total=0;
    while(true){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>maximum){try{await reader.cancel()}catch{}return {status:'provider_unavailable'}}chunks.push(part.value)}
    if(total<2)return {status:'provider_unavailable'};
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return {status:'provider_source_invalid'}};
    return {status:'downloaded',text};
  })()`;
}

function extractProvider(value) {
  const match = String(value || '').match(/amzn1\.flex\.provider\.v1\.[A-Za-z0-9-]{8,128}/);
  return match ? match[0] : '';
}

function extractTransporter(value) {
  const text = String(value || '');
  const match = text.match(/^US_(?:AMZL_)?([A-Z0-9]{8,20})_[A-Z0-9]+$/) || text.match(/\b(A[A-Z0-9]{7,19})\b/);
  return match ? match[1] : '';
}

function normalizeProviderPayload(payload, week) {
  if (!plain(payload) || payload.status !== 'downloaded' || Object.keys(payload).sort().join(',') !== 'status,text'
      || typeof payload.text !== 'string' || Buffer.byteLength(payload.text) > MAX_LIVE_PROVIDER_BYTES) fail('provider_source_invalid');
  let source;
  try { source = JSON.parse(payload.text); } catch { fail('provider_source_invalid'); }
  const raw = source?.tableData?.da_dsp_weekly_cdf?.rows;
  if (!Array.isArray(raw) || raw.length > 100_000) fail('provider_source_invalid');
  const rows = [];
  for (const item of raw) {
    let row = item;
    if (typeof row === 'string') try { row = JSON.parse(row); } catch { fail('provider_source_invalid'); }
    if (!plain(row)) fail('provider_source_invalid');
    const daName = String(row.da_name || row.delivery_associate_name || row.employee_name || row.name || '').trim();
    const transporterId = String(row.transporter_id || extractTransporter(row.country_transporterid_stationcode)
      || extractTransporter(row.country_program_transporterid_stationcode) || '').trim();
    const providerId = String(row.provider_id || extractProvider(row.country_program_providerid_stationcode)
      || extractProvider(row.country_program_daid_stationcode) || extractProvider(row.country_providerid_stationcode) || '').trim();
    if (!daName && !transporterId && !providerId) continue;
    if (!daName || !transporterId || !providerId) fail('provider_source_invalid');
    rows.push({ da_name: daName, transporter_id: transporterId, provider_id: providerId });
  }
  rows.sort((left, right) => left.transporter_id.localeCompare(right.transporter_id)
    || left.provider_id.localeCompare(right.provider_id) || left.da_name.localeCompare(right.da_name));
  const bytes = Buffer.from(`${canonicalStringify({ contract_version: 1, week, rows })}\n`);
  validateProviderJson(bytes, week);
  return bytes;
}

async function pageTargets(endpoint, signal = null) {
  let values;
  try { values = await boundedJson(`${endpoint}/json/list`, { signal }); }
  catch {
    if (signal?.aborted) fail('acquisition_cancelled');
    fail('browser_protocol_failed');
  }
  if (!Array.isArray(values) || values.length > 64) fail('browser_protocol_failed');
  return values.filter(value => value?.type === 'page').map(value => validateTarget(value, endpoint));
}

async function connectAuthenticatedPage(endpoint, { signal = null } = {}) {
  const targets = (await pageTargets(endpoint, signal)).filter(value => value.url === AUTHENTICATED_URL);
  if (targets.length !== 1) fail('authenticated_page_unavailable');
  return CdpConnection.connect(targets[0].webSocketDebuggerUrl, { commandTimeoutMs: 15_000, signal });
}

async function navigate(connection, url) {
  const result = await connection.command('Page.navigate', { url });
  if (result?.errorText) fail('navigation_failed');
}

async function collectWeeklyFromEndpoint(endpoint, request, {
  connectPage = connectAuthenticatedPage,
  clock = Date.now,
  sleep = delay,
} = {}) {
  const { week } = request.input;
  const { station, companyId, dsp } = request.source.config;
  const feedbackUrl = buildFeedbackUrl({ week, station, companyId });
  const qualityUrl = buildQualityUrl({ week, station, companyId });
  const apiUrl = buildProviderApiUrl({ week, station, dsp });
  const signal = request.signal || null;
  assertCurrent(request.deadline, signal, clock());
  const connection = await connectPage(endpoint, { signal });
  try {
    assertCurrent(request.deadline, signal, clock());
    await connection.command('Page.enable');
    assertCurrent(request.deadline, signal, clock());
    await navigate(connection, feedbackUrl);
    await waitForPage(connection, { expectedUrl: feedbackUrl, week, kind: 'feedback' }, {
      timeoutMs: PAGE_TIMEOUT_MS, signal, deadline: request.deadline, clock, sleep,
    });
    assertCurrent(request.deadline, signal, clock());
    const csvBytes = decodeCsvPayload(await connection.evaluate(downloadExpression(feedbackUrl)));
    validateCsv(csvBytes, week);
    assertCurrent(request.deadline, signal, clock());
    let providerBytes = null;
    try {
      assertCurrent(request.deadline, signal, clock());
      await navigate(connection, qualityUrl);
      await waitForPage(connection, { expectedUrl: qualityUrl, week, kind: 'quality' }, {
        timeoutMs: QUALITY_TIMEOUT_MS, signal, deadline: request.deadline, clock, sleep,
      });
      const providerPayload = await connection.evaluate(providerFetchExpression({ qualityUrl, apiUrl }));
      providerBytes = normalizeProviderPayload(providerPayload, week);
    } catch (error) {
      if (['acquisition_cancelled', 'deadline_exceeded'].includes(error?.code)) throw error;
      providerBytes = null;
    }
    assertCurrent(request.deadline, signal, clock());
    return { csvBytes, providerBytes };
  } catch (error) {
    if (error instanceof CdpError) {
      if (error.code === 'acquisition_cancelled') fail('acquisition_cancelled');
      fail(error.code === 'browser_timeout' ? 'browser_timeout' : 'browser_protocol_failed');
    }
    throw error;
  } finally { connection.close(); }
}

async function collectWeeklyArtifacts(request, {
  withBrowser = withCdfBrowser,
  collectFromEndpoint = collectWeeklyFromEndpoint,
} = {}) {
  return withBrowser({
    authProfile: request.source.authProfile,
    runId: request.runId,
    deadline: request.deadline,
    signal: request.signal || null,
  }, browser => collectFromEndpoint(browser.endpoint, { ...request, signal: browser.signal }));
}

module.exports = {
  AUTHENTICATED_URL, PERFORMANCE_ORIGIN, PERFORMANCE_PATH, PROVIDER_API_PATH,
  MAX_LIVE_CSV_BYTES, MAX_LIVE_PROVIDER_BYTES, PAGE_TIMEOUT_MS, QUALITY_TIMEOUT_MS,
  ALLOWED_CSV_TYPES, assertCurrent, exactUrl, buildFeedbackUrl, buildQualityUrl, buildProviderApiUrl,
  approvedDownloadUrl, pageSnapshotExpression, classifyPageSnapshot, waitForPage,
  downloadExpression, decodeCsvPayload, providerFetchExpression, extractProvider, extractTransporter,
  normalizeProviderPayload, pageTargets, connectAuthenticatedPage, navigate,
  collectWeeklyFromEndpoint, collectWeeklyArtifacts,
};
