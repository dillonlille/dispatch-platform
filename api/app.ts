import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { z, ZodError } from 'zod';
import { AppError, assert } from '../shared/errors.js';
import { Runtime } from '../services/runtime.js';
import { configuration, type Config } from '../services/config.js';
import type { Auth, Context } from '../services/accounts/index.js';
import type { Permission, SessionView, PlatformHealth } from '../shared/contracts/index.js';
import { dateSchema } from '../integrations/paycom/workforce.js';
import { ReleaseService } from '../services/releases/index.js';
import { previewRouting } from './preview.js';
const email = z.email().max(254),
  password = z.string().min(12).max(128),
  name = z.string().trim().min(1).max(100);
const timezone = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const role = z.enum(['owner', 'manager', 'member']);
const parse = <T>(schema: z.ZodType<T>, request: FastifyRequest) => schema.parse(request.body);
const params = (request: FastifyRequest) => request.params as Record<string, string>;
export async function createApp(
  config: Config = configuration(),
  options: { dashboardRoot?: string; startWorkers?: boolean; fixturePreview?: boolean } = {},
) {
  const runtime = new Runtime(config),
    releases = new ReleaseService(runtime.storage, runtime.audit);
  // The local fixture runner exercises separate queues and sessions for both
  // environments. Deployed Preview uses a separate API process and release.
  const preview =
    !config.standalone &&
    options.fixturePreview &&
    config.development &&
    config.providerMode === 'fixture'
      ? new Runtime({ ...config, environment: 'preview' })
      : undefined;
  const forContext = (context: Context) => {
    if (context.dsp.environment === config.environment) return runtime;
    assert(preview && context.dsp.environment === 'preview', 'preview_not_running', 503);
    return preview;
  };
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy: false,
    requestTimeout: 30_000,
    connectionTimeout: 15_000,
  });
  await app.register(cookie);
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY')
      .header('Cache-Control', 'no-store');
    const origin = new URL(config.origin);
    const bound = app.server.address();
    const permittedHosts = new Set([
      origin.host,
      `127.0.0.1:${typeof bound === 'object' && bound ? bound.port : config.port}`,
    ]);
    assert(permittedHosts.has(request.headers.host ?? ''), 'invalid_host', 400);
    if (request.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      assert(request.headers.origin === config.origin, 'invalid_origin', 403);
      assert(
        request.headers['content-type']?.split(';')[0] === 'application/json',
        'json_required',
        415,
      );
    }
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'${config.development ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${config.development ? ' ws:' : ''}; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
  });
  previewRouting(app, runtime);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: 'invalid_input', message: 'Check the fields and try again.' });
    if (error instanceof AppError)
      return reply.code(error.status).send({ error: error.code, message: error.message });
    if ((error as { statusCode?: number }).statusCode === 413)
      return reply
        .code(413)
        .send({ error: 'request_too_large', message: 'The request is too large.' });
    return reply
      .code(500)
      .send({ error: 'operation_failed', message: 'The operation could not be completed.' });
  });
  const auth = (request: FastifyRequest): Auth =>
    runtime.accounts.authenticate(request.cookies.dispatch_session);
  const mutation = (request: FastifyRequest) => {
    const value = auth(request);
    runtime.accounts.checkCsrf(value, request.headers['x-csrf-token']);
    return value;
  };
  const owner = (request: FastifyRequest, write = false) => {
    const value = write ? mutation(request) : auth(request);
    runtime.accounts.platform(value);
    return value;
  };
  const context = (request: FastifyRequest, permission: Permission = 'read', write = false) =>
    runtime.accounts.fromView(
      write ? mutation(request) : auth(request),
      request.headers['x-dispatch-view'],
      permission,
    );
  app.get('/api/health', () => ({
    status: 'ready',
    environment: config.environment,
    release: config.release,
  }));
  app.post('/api/auth/login', async (request, reply) => {
    const input = parse(z.object({ email, password: z.string().max(128) }).strict(), request);
    const result = await runtime.accounts.login(input.email, input.password, request.ip);
    reply.setCookie('dispatch_session', result.raw, {
      httpOnly: true,
      secure: !config.development,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 3600,
    });
    return { ok: true };
  });
  app.post('/api/auth/logout', (request, reply) => {
    runtime.accounts.logout(mutation(request));
    reply.clearCookie('dispatch_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/session', (request) => {
    const a = auth(request);
    return {
      user: a.user,
      csrf: a.csrf,
      dsps: runtime.dsps.list(a),
      development: config.development,
      environment: config.environment,
      release: config.release,
      separatePreview: Boolean(config.previewOrigin),
      standalone: config.standalone,
      providerMode: config.providerMode,
    };
  });
  app.post('/api/session/dsp', (request) => {
    const a = mutation(request);
    const input = parse(z.object({ dspId: z.string() }).strict(), request);
    return runtime.accounts.view(a, input.dspId);
  });
  app.post('/api/auth/password', async (request, reply) => {
    const a = mutation(request);
    const input = parse(
      z.object({ currentPassword: z.string().max(128), password }).strict(),
      request,
    );
    await runtime.accounts.changePassword(a, input.currentPassword, input.password);
    reply.clearCookie('dispatch_session', { path: '/' });
    return { ok: true };
  });
  app.post('/api/auth/forgot-password', (request, reply) => {
    const input = parse(z.object({ email }).strict(), request);
    runtime.accounts.throttle(`forgot:ip:${request.ip}`, 20, 3600_000);
    runtime.accounts.throttle(`forgot:email:${input.email.toLowerCase()}`, 5, 3600_000);
    assert(runtime.mail.available(), 'email_unavailable', 503);
    const result = runtime.accounts.recoveryToken(input.email);
    if (result)
      runtime.mail.enqueue({
        to: result.email,
        subject: 'Reset your Dispatch password',
        text: `Open ${config.origin}/#reset?token=${result.raw} to reset your password. This link expires in 30 minutes.`,
      });
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/auth/reset-password', async (request) => {
    runtime.accounts.throttle(`reset:${request.ip}`, 30, 3600_000);
    const input = parse(z.object({ token: z.string().length(43), password }).strict(), request);
    await runtime.accounts.resetPassword(input.token, input.password);
    return { ok: true };
  });
  app.get('/api/invitations/:token', (request) => {
    runtime.accounts.throttle(`invite-read:${request.ip}`, 60, 60_000);
    return runtime.accounts.invitation(z.string().length(43).parse(params(request).token));
  });
  app.post('/api/invitations/:token/accept', async (request) => {
    runtime.accounts.throttle(`invite:${request.ip}`, 20, 3600_000);
    const input = parse(z.object({ firstName: name, lastName: name, password }).strict(), request);
    await runtime.accounts.acceptInvitation(
      z.string().length(43).parse(params(request).token),
      { firstName: input.firstName, lastName: input.lastName },
      input.password,
    );
    return { ok: true };
  });
  app.get('/api/platform/dsps', (request) => runtime.dsps.list(owner(request)));
  app.post('/api/platform/dsps', (request, reply) => {
    const a = owner(request, true);
    const input = parse(
      z.object({ name, timezone, ownerEmail: email.optional() }).strict(),
      request,
    );
    const dsp = runtime.dsps.create(input.name, input.timezone, a.user.id);
    let invitationUrl: string | undefined;
    if (input.ownerEmail) {
      const token = runtime.accounts.invite(a, dsp.id, input.ownerEmail, 'owner');
      invitationUrl = `${config.origin}/#invite?token=${token}`;
      runtime.mail.enqueue({
        to: input.ownerEmail,
        subject: `Join ${dsp.name} on Dispatch`,
        text: `You have been invited to ${dsp.name}. Open ${invitationUrl}`,
      });
    }
    return reply.code(201).send({ dsp, invitationUrl });
  });
  app.post('/api/platform/dsps/:id/status', async (request) => {
    const a = owner(request, true);
    const input = parse(z.object({ status: z.enum(['active', 'suspended']) }).strict(), request);
    const dsp = runtime.dsps.setStatus(params(request).id!, input.status, a.user.id);
    if (input.status === 'suspended') {
      await runtime.runner.revokeDsp(dsp.id);
      await preview?.runner.revokeDsp(dsp.id);
    }
    return dsp;
  });
  app.post('/api/platform/dsps/:id/retry', (request) => {
    owner(request, true);
    runtime.dsps.initialize(params(request).id!);
    return runtime.dsps.get(params(request).id!);
  });
  app.get('/api/platform/jobs', (request) => {
    owner(request);
    return [...runtime.runner.queue.list(), ...(preview?.runner.queue.list() ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  });
  app.get('/api/platform/audit', (request) => {
    owner(request);
    return runtime.audit.list();
  });
  app.get('/api/platform/health', (request): PlatformHealth => {
    owner(request);
    return {
      environment: config.environment,
      release: config.release,
      jobs: Object.fromEntries(
        runtime.storage.jobs
          .all<{ status: string; n: number }>('SELECT status,count(*) n FROM jobs GROUP BY status')
          .map((r) => [r.status, r.n]),
      ),
      browsers: runtime.browsers.health(),
      dsps: runtime.storage.platform.one<{ n: number }>('SELECT count(*) n FROM dsps')!.n,
      email: runtime.mail.available(),
      providerMode: config.providerMode,
    };
  });
  app.get('/api/platform/releases', (request) => {
    owner(request);
    const statusFile = path.join(runtime.storage.paths.platform, 'dev-update.json');
    let update: unknown = null;
    if (config.standalone && fs.existsSync(statusFile)) {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      update = { status: status.status, commit: status.commit, updatedAt: status.updatedAt };
    }
    return {
      releases: releases.list(),
      deploymentEnabled: config.allowDeployment,
      standalone: config.standalone,
      environment: config.environment,
      release: config.release,
      update,
    };
  });
  app.post('/api/platform/releases/:digest/tested', (request) => {
    const a = owner(request, true);
    assert(!config.standalone, 'github_manages_updates', 409);
    releases.markTested(params(request).digest!, a.user.id);
    return { ok: true };
  });
  app.post('/api/platform/releases/:digest/deploy', (request) => {
    const a = owner(request, true);
    const input = parse(
      z.object({ environment: z.enum(['preview', 'production']) }).strict(),
      request,
    );
    return releases.request(params(request).digest!, input.environment, a.user.id);
  });
  app.get('/api/dsp/overview', (request) => {
    const c = context(request),
      r = forContext(c);
    return {
      dsp: c.dsp,
      connection: r.broker.connection(c.dsp.id),
      schedule: r.runner.schedules.get(c.dsp.id),
      jobs: r.runner.queue.list(c.dsp.id).slice(0, 8),
      workforce: r.runner.workforce.employees(c.dsp.id, '', 0, 5),
      audit: runtime.audit.list(c.dsp.id, 10),
    };
  });
  app.get('/api/dsp/connections', (request) => {
    const c = context(request, 'connections');
    return forContext(c).broker.connection(c.dsp.id);
  });
  app.post('/api/dsp/connections/paycom', async (request) => {
    const c = context(request, 'connections', true),
      r = forContext(c);
    const input = parse(
      z
        .object({
          clientCode: z.string().trim().min(1).max(80),
          username: z.string().trim().min(1).max(200),
          password: z.string().min(1).max(256),
        })
        .strict(),
      request,
    );
    await r.runner.revokeDsp(c.dsp.id);
    await r.broker.save(c.dsp, input, c.user.id, () =>
      runtime.accounts.revalidate(c, 'connections'),
    );
    runtime.accounts.revalidate(c, 'connections');
    return r.broker.connection(c.dsp.id);
  });
  app.post('/api/dsp/connections/paycom/check', async (request) => {
    const c = context(request, 'connections', true),
      r = forContext(c);
    await r.broker.ensure(c.dsp);
    runtime.accounts.revalidate(c, 'connections');
    return r.broker.connection(c.dsp.id);
  });
  app.post('/api/dsp/connections/paycom/verify', async (request) => {
    const c = context(request, 'connections', true),
      r = forContext(c);
    const input = parse(z.object({ code: z.string().min(1).max(128) }).strict(), request);
    const result = await r.broker.verify(c.dsp, input.code, c.user.id);
    runtime.accounts.revalidate(c, 'connections');
    return result;
  });
  app.post('/api/dsp/connections/paycom/disable', async (request) => {
    const c = context(request, 'connections', true),
      r = forContext(c);
    const input = parse(
      z.object({ removeCredentials: z.boolean().default(false) }).strict(),
      request,
    );
    await r.runner.revokeDsp(c.dsp.id);
    await r.broker.disable(c.dsp.id, c.user.id, input.removeCredentials);
    runtime.accounts.revalidate(c, 'connections');
    return r.broker.connection(c.dsp.id);
  });
  app.get('/api/dsp/connections/paycom/screenshot', async (request) => {
    const c = context(request, 'connections'),
      r = forContext(c);
    const session = r.browsers.sessions.get(c.dsp.id);
    assert(session, 'assistance_unavailable', 409);
    const image = await session.screenshot();
    runtime.accounts.revalidate(c, 'connections');
    return { image };
  });
  app.post('/api/dsp/connections/paycom/assist', async (request) => {
    const c = context(request, 'connections', true),
      r = forContext(c);
    const input = parse(
      z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('click'),
            x: z.number().min(0).max(1200),
            y: z.number().min(0).max(800),
          })
          .strict(),
        z.object({ kind: z.literal('type'), text: z.string().max(256) }).strict(),
        z
          .object({
            kind: z.literal('key'),
            key: z.enum(['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp']),
          })
          .strict(),
      ]),
      request,
    );
    const session = r.browsers.sessions.get(c.dsp.id);
    assert(session, 'assistance_unavailable', 409);
    await session.assist(input);
    runtime.accounts.revalidate(c, 'connections');
    runtime.audit.record(c.user.id, c.dsp.id, 'connection.assistance_used');
    return r.broker.connection(c.dsp.id);
  });
  app.get('/api/dsp/jobs', (request) => {
    const c = context(request);
    return forContext(c).runner.queue.list(c.dsp.id);
  });
  app.post('/api/dsp/jobs', (request, reply) => {
    const c = context(request, 'collect', true);
    const input = parse(z.object({ requestId: z.string().min(1).max(128) }).strict(), request);
    const job = forContext(c).runner.queue.enqueue(c.dsp.id, c.user.id, input.requestId);
    runtime.audit.record(c.user.id, c.dsp.id, 'collection.requested');
    return reply.code(202).send(job);
  });
  app.post('/api/dsp/jobs/:id/cancel', async (request) => {
    const c = context(request, 'collect', true);
    const result = await forContext(c).runner.cancel(params(request).id!, c.dsp.id);
    runtime.accounts.revalidate(c, 'collect');
    runtime.audit.record(c.user.id, c.dsp.id, 'collection.cancelled');
    return result;
  });
  app.get('/api/dsp/schedule', (request) => {
    const c = context(request);
    return forContext(c).runner.schedules.get(c.dsp.id);
  });
  app.post('/api/dsp/schedule', (request) => {
    const c = context(request, 'settings', true);
    const input = parse(
      z
        .object({ enabled: z.boolean(), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
        .strict(),
      request,
    );
    const result = forContext(c).runner.schedules.set(
      c.dsp.id,
      input.enabled,
      input.localTime,
      c.dsp.timezone,
    );
    runtime.audit.record(c.user.id, c.dsp.id, 'schedule.updated');
    return result;
  });
  app.get('/api/dsp/employees', (request) => {
    const c = context(request),
      input = z
        .object({
          q: z.string().max(100).default(''),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .strict()
        .parse(request.query);
    return forContext(c).runner.workforce.employees(c.dsp.id, input.q, input.offset, input.limit);
  });
  app.get('/api/dsp/employees/:code', (request) => {
    const c = context(request);
    return forContext(c).runner.workforce.employee(
      c.dsp.id,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,32}$/)
        .parse(params(request).code),
    );
  });
  app.get('/api/dsp/timecards', (request) => {
    const c = context(request),
      input = z
        .object({
          date: dateSchema,
          sort: z.enum(['name', 'hours']).default('name'),
          direction: z.enum(['asc', 'desc']).default('asc'),
        })
        .strict()
        .parse(request.query);
    return forContext(c).runner.workforce.daily(c.dsp.id, input.date, input.sort, input.direction);
  });
  app.get('/api/dsp/members', (request) => {
    const c = context(request, 'members');
    return runtime.dsps.members(c.dsp.id);
  });
  app.post('/api/dsp/members/invite', (request) => {
    const c = context(request, 'members', true),
      input = parse(z.object({ email, role }).strict(), request);
    const token = runtime.accounts.invite(c, c.dsp.id, input.email, input.role),
      invitationUrl = `${config.origin}/#invite?token=${token}`;
    runtime.mail.enqueue({
      to: input.email,
      subject: `Join ${c.dsp.name} on Dispatch`,
      text: `Open ${invitationUrl} to accept your invitation.`,
    });
    return { invitationUrl };
  });
  app.post('/api/dsp/members/:id', (request) => {
    const c = context(request, 'members', true),
      input = parse(z.object({ role: role.nullable() }).strict(), request);
    runtime.dsps.setRole(c, params(request).id!, input.role);
    return { ok: true };
  });
  app.post('/api/dsp/settings', (request) => {
    const c = context(request, 'settings', true),
      input = parse(z.object({ name, timezone }).strict(), request);
    return runtime.dsps.update(c, input.name, input.timezone);
  });
  if (options.dashboardRoot && fs.existsSync(options.dashboardRoot)) {
    await app.register(staticFiles, {
      root: path.join(options.dashboardRoot, 'assets'),
      prefix: '/assets/',
      decorateReply: true,
      maxAge: '1y',
      immutable: true,
    });
    app.get('/', async (_, reply) =>
      reply
        .type('text/html')
        .send(fs.readFileSync(path.join(options.dashboardRoot!, 'index.html'))),
    );
  }
  app.setNotFoundHandler((_, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'This page could not be found.' }),
  );
  app.addHook('onClose', async () => {
    await preview?.close();
    await runtime.close();
  });
  if (options.startWorkers) {
    runtime.start();
    preview?.start();
  }
  return { app, runtime, preview, releases };
}
