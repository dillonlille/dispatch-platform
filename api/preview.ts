import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Runtime } from '../services/runtime.js';
import { sign, equal, sha256 } from '../shared/crypto.js';
import { assert } from '../shared/errors.js';
function proof(
  key: string,
  request: { method: string; url: string; body?: unknown },
  expires: string,
) {
  return sign(
    Buffer.from(key, 'base64url'),
    `${expires}:${request.method}:${request.url}:${sha256(JSON.stringify(request.body ?? null))}`,
  );
}
export function previewRouting(app: FastifyInstance, runtime: Runtime) {
  const config = runtime.config;
  app.addHook('preHandler', async (request, reply) => {
    if (request.url === '/api/health') return;
    if (config.environment === 'preview' && config.previewKey) {
      const expires = String(request.headers['x-preview-expires'] ?? ''),
        signature = String(request.headers['x-preview-proof'] ?? '');
      assert(
        Number(expires) > Date.now() &&
          Number(expires) < Date.now() + 60_000 &&
          equal(signature, proof(config.previewKey, request, expires)),
        'preview_gateway_required',
        403,
      );
    }
    if (config.environment !== 'production' || !config.previewOrigin || !config.previewKey) return;
    let url = request.url;
    if (url.startsWith('/api/dsp/')) {
      const auth = runtime.accounts.authenticate(request.cookies.dispatch_session);
      if (request.method !== 'GET')
        runtime.accounts.checkCsrf(auth, request.headers['x-csrf-token']);
      const context = runtime.accounts.fromView(auth, request.headers['x-dispatch-view']);
      if (context.dsp.environment !== 'preview') return;
    } else if (url === '/preview/' || url.startsWith('/preview/assets/')) {
      const auth = runtime.accounts.authenticate(request.cookies.dispatch_session);
      const dev = runtime.dsps.list(auth).find((dsp) => dsp.permanent && dsp.status === 'active');
      assert(dev, 'permission_denied', 403);
      url = url.slice('/preview'.length);
    } else return;
    const expires = String(Date.now() + 30_000),
      headers: Record<string, string> = {
        host: new URL(config.origin).host,
        'x-preview-expires': expires,
        'x-preview-proof': proof(
          config.previewKey,
          { method: request.method, url, body: request.body },
          expires,
        ),
      };
    for (const key of ['cookie', 'origin', 'content-type', 'x-csrf-token', 'x-dispatch-view']) {
      const value = request.headers[key];
      if (typeof value === 'string') headers[key] = value;
    }
    let response: Response;
    try {
      response = await fetch(config.previewOrigin + url, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: JSON.stringify(request.body ?? {}) }),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      return reply.code(503).send({
        error: 'preview_unavailable',
        message: 'Preview is unavailable. Production DSPs remain available.',
      });
    }
    reply
      .code(response.status)
      .header('content-type', response.headers.get('content-type') ?? 'application/json');
    return reply.send(Buffer.from(await response.arrayBuffer()));
  });
}
