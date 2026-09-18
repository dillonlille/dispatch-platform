import type { Env } from './worker-configuration.js';
import { timingSafeEqual } from 'node:crypto';

const reply = (status: number, value: object) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/send')
      return reply(404, { error: 'not_found' });
    const expected = new TextEncoder().encode(`Bearer ${env.MAIL_TOKEN}`);
    const actual = new TextEncoder().encode(request.headers.get('authorization') ?? '');
    if (!env.MAIL_TOKEN || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply(401, { error: 'unauthorized' });
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return reply(415, { error: 'json_required' });
    // Bound the stream itself; Content-Length can be absent or untrustworthy.
    const reader = request.body?.getReader();
    if (!reader) return reply(400, { error: 'invalid_message' });
    let body = '';
    let size = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        return reply(413, { error: 'message_too_large' });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return reply(400, { error: 'invalid_message' });
    }
    if (
      !message ||
      message.environment !== env.DISPATCH_ENVIRONMENT ||
      message.origin !== env.DISPATCH_ORIGIN
    )
      return reply(403, { error: 'email_environment_mismatch' });
    if (
      typeof message.to !== 'string' ||
      message.to.length > 254 ||
      !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(message.to) ||
      typeof message.subject !== 'string' ||
      !message.subject ||
      message.subject.length > 200 ||
      /[\r\n]/.test(message.subject) ||
      typeof message.text !== 'string' ||
      !message.text ||
      (message.html != null && typeof message.html !== 'string') ||
      (env.DISPATCH_ENVIRONMENT === 'preview' && !message.subject.startsWith('[Dispatch Dev] '))
    )
      return reply(400, { error: 'invalid_message' });
    try {
      const result = await env.EMAIL.send({
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      if (!result.messageId) return reply(502, { error: 'email_delivery_failed' });
      return reply(200, { ok: true });
    } catch {
      // Never log addresses, tokens, or message bodies.
      console.error(
        JSON.stringify({ event: 'email_delivery_failed', environment: env.DISPATCH_ENVIRONMENT }),
      );
      return reply(502, { error: 'email_delivery_failed' });
    }
  },
};
