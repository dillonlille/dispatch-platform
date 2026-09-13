'use strict';
const http = require('node:http');
const { AccessError } = require('../accounts/src');
const { createAccessHttp } = require('./access-http');
const { createInstallationRuntimeResolver } = require('./runtime-router');
const { SERVER_OPTIONS, IDEMPOTENCY_RE, dashboardConfig, sourceDate, dailyQuery, publicSyncView,
  publicSdkFailure, publicSdkResult, publicHttpFailure, integerParameter, readJson,
  sendJson, securityHeaders, checkedPublicOrigin, requirePublicRequest } = require('./http');
function createApiHandler({
  client,
  access,
  config = dashboardConfig(),
  fallback = null,
  operator = false,
  secureCookies = false,
  publicOrigin = null,
  requireInvitationDelivery = Boolean(publicOrigin),
  invitationDelivery = null,
  turnstile = null,
  paycomSetup = null,
  connections = null,
  updates = null,
  releasePopup = null,
  backups = null,
  platformRuntime = null,
  plugins = null,
  pluginAssets = null,
  dashboards = null,
  runtimeResolver = null,
  coreIdentity = null, coreMaintenance = () => null,
  now = () => new Date(),
} = {}) {
  if (!client?.workforce || typeof client.workforce.day !== 'function'
      || !client?.sync || typeof client.sync.status !== 'function' || typeof client.sync.runNow !== 'function'
      || !client?.system || typeof client.system.status !== 'function'
      || !access || typeof access.session !== 'function' || typeof access.runtimeFor !== 'function'
      || typeof coreMaintenance !== 'function' || typeof operator !== 'boolean' || typeof secureCookies !== 'boolean'
      || (invitationDelivery !== null && typeof invitationDelivery?.send !== 'function')
      || (runtimeResolver !== null && typeof runtimeResolver !== 'function') || typeof now !== 'function') {
    throw new TypeError('dashboard_dependencies_required');
  }
  const checkedOrigin = checkedPublicOrigin(publicOrigin);
  if (checkedOrigin && !secureCookies) throw new TypeError('dashboard_dependencies_required');
  const accessHttp = createAccessHttp({
    access,
    secureCookies,
    trustCloudflareAddress: Boolean(checkedOrigin),
    invitationDelivery,
    turnstile,
    paycomSetup,
    connections,
    updates,
    releasePopup,
    backups,
    platformRuntime,
    plugins,
    requireInvitationDelivery,
    clock: now,
  });
  const resolveRuntime = runtimeResolver || createInstallationRuntimeResolver({
    localClient: client,
    localOrganizationId: config.organization.id,
  });
  const runtimeContext = (request, permission) => {
    const session = accessHttp.session(request);
    const context = access.runtimeFor(session, permission);
    const runtime = resolveRuntime(context.installation, context.organization);
    if (!runtime) throw new AccessError('installation_not_ready', 409);
    return { ...context, runtime, session };
  };

  const pluginOperations = require('./plugin-operations').createPluginOperations({ access, accessHttp, runtimeContext });

  // Legacy public URLs translate into scoped SDK operations. Core never loads
  // executable HTTP handlers from another repository or an installed plugin.
  const pluginHandlers = [{ id: 'paycom', httpPrefixes: ['/api/paycom'] }].map(definition => {
    const handler = require('./compatibility-paycom').createHandler({
      runtimeContext: (request, permission) => {
        const current = accessHttp.session(request);
        require('../accounts/src/plugins').requirePlugin(access, current, definition.id);
        return runtimeContext(request, permission);
      },
      access, accessHttp, config, now, readJson, sendJson, dailyQuery, publicSdkFailure,
      publicSyncView, publicSdkResult, integerParameter, IDEMPOTENCY_RE,
    });
    return { definition, handler };
  });

  return async (request, response) => {
    try {
      if (typeof request.url !== 'string' || !/^\/(?!\/)[^\0\r\n\\]*$/.test(request.url)) {
        throw new AccessError('request_forbidden', 403);
      }
      const redirect = requirePublicRequest(request, checkedOrigin);
      if (redirect) {
        response.writeHead(308, {
          ...securityHeaders('text/plain; charset=utf-8'),
          'Cache-Control': 'no-store',
          'Content-Length': 0,
          Location: redirect,
        });
        response.end();
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/platform/core-health' && !url.search) {
        if (!coreIdentity) throw new AccessError('core_identity_unavailable', 503);
        access.store.db.prepare('SELECT count(*) FROM users').get();
        const state = coreMaintenance();
        const probe = require('./core-maintenance').probeAllowed(state, request.headers['x-dispatch-recovery-probe']);
        if (probe) require('../installations/src/core-database-probe').verifyCoreDatabase(access.store.db);
        sendJson(response, 200, { ok: true, data: { ...coreIdentity, ...(probe ? { recoveryProbe: 'passed' } : {}) }, error: null });
        return;
      }
      if (coreMaintenance()) {
        response.writeHead(503, { ...securityHeaders('text/plain; charset=utf-8'), 'Cache-Control': 'no-store', 'Retry-After': '10' });
        response.end('Dispatch is verifying an update. Please try again shortly.');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health' && !url.search) {
        access.store.db.prepare('SELECT 1 FROM users LIMIT 1').get();
        sendJson(response, 200, { ok: true, status: 'ready', data: { service: 'dispatch-api' }, error: null });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        if (!dashboards || (url.search && url.search !== '?identity=1')) throw new AccessError('release_dashboard_unavailable', 503);
        const current=accessHttp.session(request,{required:false});
        sendJson(response,200,{ok:true,data:dashboards(current,url.search === '?identity=1'),error:null});return;
      }
      if (dashboards && !['GET','HEAD','OPTIONS'].includes(request.method) && request.headers['x-dispatch-dashboard']) {
        const current=accessHttp.session(request,{required:false});
        if(dashboards(current,true).digest!==request.headers['x-dispatch-dashboard']) throw new AccessError('dashboard_changed',409);
      }
      const pluginAsset = /^\/api\/plugin-assets\/([a-z][a-z0-9-]{0,63})\/([1-9][0-9]{0,14})$/.exec(url.pathname);
      if (pluginAsset && request.method === 'GET' && !url.search) {
        const session = accessHttp.session(request);
        const organization = require('../accounts/src/plugins').requirePlugin(access, session, pluginAsset[1]);
        const installation = access.store.installation(organization.id);
        const revision = Number(pluginAsset[2]);
        const current = access.store.db.prepare('SELECT revision FROM dsp_plugins WHERE organization_id=? AND plugin_id=?').get(organization.id, pluginAsset[1]);
        if (current?.revision !== revision || !installation || typeof pluginAssets !== 'function') throw new AccessError('plugin_unavailable', 409);
        const data = await pluginAssets({ runtimeKey: installation.runtimeKey, pluginId: pluginAsset[1], revision });
        const currentSession = accessHttp.session(request);
        const after = require('../accounts/src/plugins').requirePlugin(access, currentSession, pluginAsset[1]);
        if (after.id !== organization.id || access.store.installation(after.id)?.runtimeKey !== installation.runtimeKey || access.store.db.prepare('SELECT revision FROM dsp_plugins WHERE organization_id=? AND plugin_id=?').get(organization.id, pluginAsset[1])?.revision !== revision) throw new AccessError('plugin_unavailable', 409);
        sendJson(response, 200, { ok: true, status: 'found', data, error: null }); return;
      }
      if (await accessHttp.route(request, response, url, { readJson, sendJson })) return;
      if (await pluginOperations(request, response, url)) return;
      for (const { definition, handler } of pluginHandlers) {
        if (definition.httpPrefixes.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))
            && await handler(request, response, url)) return;
      }

      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const { runtime, organization, membership, session } = runtimeContext(request, null);
        const syncResult = require('../accounts/src/plugins').available(access.store, organization.id, 'paycom')
          ? await runtime.sync.status(config.syncId) : null;
        const sync = publicSyncView(syncResult);
        const timezone = sync.data?.businessContext?.timezone || organization.timezone;
        sendJson(response, 200, {
          ok: true,
          status: 'ready',
          data: {
            organization: { id: organization.id, name: organization.name, abbreviation: organization.abbreviation },
            site: { id: `${organization.id}:${organization.stations[0].code}`, code: organization.stations[0].code },
            user: { name: session.user.name, role: membership.roleName },
            timezone,
            today: sourceDate(now(), timezone),
            operatorActions: operator && membership.permissions.includes('sync.run'),
            csrfToken: session.csrfToken,
          },
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/integrations') {
        const { runtime, organization } = runtimeContext(request, 'integrations.read');
        const [system, syncResult] = await Promise.all([
          runtime.system.status(),
          require('../accounts/src/plugins').available(access.store, organization.id, 'paycom')
            ? runtime.sync.status(config.syncId) : null,
        ]);
        const systemError = system.ok ? null : publicSdkFailure(system, 'system_unavailable');
        sendJson(response, system.ok ? 200 : 503, {
          ok: system.ok,
          status: system.ok ? system.status : systemError.code,
          data: system.ok ? { system: system.data, paycomSync: publicSyncView(syncResult) } : null,
          error: systemError,
        });
        return;
      }

      if (!['GET', 'HEAD'].includes(request.method)) {
        sendJson(response, 405, { ok: false, status: 'method_not_allowed', data: null, error: { code: 'method_not_allowed' } });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { ok: false, status: 'not_found', data: null, error: { code: 'not_found' } });
        return;
      }
      if (!fallback || !await fallback(request, response, url)) {
        sendJson(response, 404, { ok: false, status: 'not_found', data: null, error: { code: 'not_found' } });
      }
    } catch (error) {
      const { statusCode, code } = publicHttpFailure(error);
      sendJson(response, statusCode, { ok: false, status: code, data: null, error: { code } });
    }
  };
}

function createApiServer(options) { return http.createServer(SERVER_OPTIONS, createApiHandler(options)); }
module.exports = { createApiHandler, createApiServer, SERVER_OPTIONS };
