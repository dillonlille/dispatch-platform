'use strict';

const http = require('node:http');
const { AccessError } = require('../../core/accounts/src/validation');
const { SERVER_OPTIONS, checkedPublicOrigin, requirePublicRequest, securityHeaders, sendJson, publicHttpFailure } = require('../../core/api/http');
const { DEFAULT_PUBLIC_ROOT, loadStaticFiles, sendStatic } = require('./static');

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
function endToEndHeaders(headers) {
  const excluded = new Set([...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(x => x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}
function checkedApiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('api_origin_invalid'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.origin !== value || !url.port || Number(url.port) < 1024
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('api_origin_invalid');
  }
  return url;
}

// The UI server owns no account store, runtime controller, or DSP credentials.
// It preserves the public request's cookies, CSRF, signed DSP view, and Host.
// Requests are streamed once, including mutations; failures are never replayed.
function createDashboardShell({ apiOrigin, publicRoot = DEFAULT_PUBLIC_ROOT, publicOrigin = null,
  turnstile = false, upstreamTimeoutMs = 300_000 } = {}) {
  const upstream = checkedApiOrigin(apiOrigin), origin = checkedPublicOrigin(publicOrigin);
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1 || upstreamTimeoutMs > 300_000) throw new TypeError('api_timeout_invalid');
  const files = loadStaticFiles(publicRoot);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16 });
  const server = http.createServer(SERVER_OPTIONS, (request, response) => {
    try {
      if (typeof request.url !== 'string' || !/^\/(?!\/)[^\0\r\n\\]*$/.test(request.url)) throw new AccessError('request_forbidden', 403);
      const redirect = requirePublicRequest(request, origin);
      if (redirect) {
        response.writeHead(308, { ...securityHeaders(), 'Cache-Control': 'no-store', 'Content-Length': 0, Location: redirect });
        response.end(); return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const forward = http.request({ hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port,
          path: request.url, method: request.method, headers: endToEndHeaders(request.headers), agent }, result => {
          response.writeHead(result.statusCode, endToEndHeaders(result.headers));
          result.on('error', () => response.destroy());
          result.pipe(response);
        });
        const timeout = setTimeout(() => forward.destroy(new Error('api_timeout')), upstreamTimeoutMs);
        timeout.unref();
        const cleanup = () => { clearTimeout(timeout); if (!response.writableFinished) forward.destroy(); };
        response.once('close', cleanup);
        request.once('aborted', () => forward.destroy());
        forward.once('error', () => {
          clearTimeout(timeout);
          if (response.destroyed) return;
          if (response.headersSent) { response.destroy(); return; }
          sendJson(response, 502, { ok: false, status: 'api_unavailable', data: null, error: { code: 'api_unavailable' } });
        });
        request.pipe(forward); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        sendJson(response, 405, { ok: false, status: 'method_not_allowed', data: null, error: { code: 'method_not_allowed' } }); return;
      }
      if (!sendStatic(response, files, url.pathname, request.method, turnstile)) {
        sendJson(response, 404, { ok: false, status: 'not_found', data: null, error: { code: 'not_found' } });
      }
    } catch (error) {
      const { statusCode, code } = publicHttpFailure(error);
      sendJson(response, statusCode, { ok: false, status: code, data: null, error: { code } });
    }
  });
  server.once('close', () => agent.destroy());
  return server;
}
module.exports = { createDashboardShell, checkedApiOrigin };
