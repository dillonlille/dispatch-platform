'use strict';

const net = require('node:net');
const { AccessError, exact } = require('../accounts/src');

const LOCAL_SESSION_COOKIE = 'dispatch_session';
const PUBLIC_SESSION_COOKIE = '__Host-dispatch_session';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 8;
const LOGIN_ADDRESS_ATTEMPTS = 40;
const INVITATION_ADDRESS_ATTEMPTS = 30;

function cookieHeader(name, value, { maxAge = null, secure = false } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (maxAge !== null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function sessionToken(request, cookieName = LOCAL_SESSION_COOKIE) {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length > 4096) return null;
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function invitePath(token) { return `/#/invitation/${token}`; }

function createAccessHttp({
  access, secureCookies = false, trustCloudflareAddress = false, invitationDelivery = null, turnstile = null,
  paycomSetup = null, connections = null, plugins = null, updates = null, releasePopup = null, backups = null,
  platformRuntime = null, requireInvitationDelivery = false, clock = () => new Date(),
}) {
  if (!access || typeof access.requireSession !== 'function' || typeof secureCookies !== 'boolean'
      || typeof trustCloudflareAddress !== 'boolean'
      || (invitationDelivery !== null && typeof invitationDelivery?.send !== 'function')
      || (turnstile !== null && (typeof turnstile?.verify !== 'function' || typeof turnstile?.publicConfig?.siteKey !== 'string'))
      || typeof requireInvitationDelivery !== 'boolean' || typeof clock !== 'function') {
    throw new TypeError('access_http_dependencies_required');
  }
  const attempts = new Map();
  const invitationAttempts = new Map();
  const sessionCookie = secureCookies ? PUBLIC_SESSION_COOKIE : LOCAL_SESSION_COOKIE;

  function session(request, { required = true } = {}) {
    const token = sessionToken(request, sessionCookie);
    const current = token ? access.session(token) : null;
    if (!current && required) throw new AccessError('authentication_required', 401);
    const viewRef = request.headers['x-dispatch-dsp-view'];
    return current && viewRef !== undefined ? access.dspViewSession(current, viewRef) : current;
  }

  function requireJson(request) {
    const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new AccessError('content_type_required', 415);
  }

  function requireMutation(request, current, url) {
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new AccessError('request_forbidden', 403);
    if (!current || request.headers['x-dispatch-csrf'] !== current.csrfToken) throw new AccessError('csrf_invalid', 403);
    requireJson(request);
    requireNoQuery(url);
    if ((current.dspView || current.user.platformRole !== 'owner') && access.store?.releaseBlocked?.(current.activeOrganizationId)) throw new AccessError('release_busy', 409);
  }

  function activeOrganizationId(current) {
    if (!current.activeOrganizationId) throw new AccessError('organization_required', 409);
    return current.activeOrganizationId;
  }

  function requireNoQuery(url) {
    if (url.search) throw new AccessError('invalid_request', 400);
  }

  function publicSession(current) {
    if (!current) return { authenticated: false, bootstrap: access.bootstrapStatus(), turnstile: turnstile?.publicConfig ?? null };
    return {
      authenticated: true,
      turnstile: turnstile?.publicConfig ?? null,
      user: current.user,
      platformPermissions: current.platformPermissions,
      activeOrganizationId: current.activeOrganizationId,
      ...(current.dspView ? { dspView: current.dspView } : {}),
      memberships: current.memberships.map(membership => ({
        id: membership.id,
        organizationId: membership.organizationId,
        roleId: membership.roleId,
        roleKey: membership.roleKey,
        roleName: membership.roleName,
        status: membership.status,
        permissions: membership.permissions,
        organization: {
          id: membership.organization.id,
          name: membership.organization.name,
          abbreviation: membership.organization.abbreviation,
          timezone: membership.organization.timezone,
          status: membership.organization.status,
          stations: membership.organization.stations,
        },
      })),
      plugins: current.activeOrganizationId ? (plugins?.listForOrganization
        ? plugins.listForOrganization(current.activeOrganizationId)
        : require('../accounts/src/plugins').listFor(access.store, current.activeOrganizationId)) : [],
      csrfToken: current.csrfToken,
      expiresAt: current.expiresAt,
    };
  }

  function requestAddress(request) {
    const direct = request.socket.remoteAddress || 'unknown';
    const forwarded = request.headers['cf-connecting-ip'];
    if (trustCloudflareAddress && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(direct)
        && typeof forwarded === 'string' && !forwarded.includes(',') && net.isIP(forwarded.trim())) {
      return forwarded.trim();
    }
    return direct;
  }

  function loginKeys(request, body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : 'invalid';
    const address = requestAddress(request);
    return Object.freeze([
      { key: `${address}\0${email}`, limit: LOGIN_ATTEMPTS },
      { key: `${address}\0*`, limit: LOGIN_ADDRESS_ATTEMPTS },
    ]);
  }

  function assertLoginAllowed(keys) {
    const timestamp = clock().getTime();
    if (attempts.size > 4096) {
      for (const [candidate, value] of attempts) if (value.resetAt <= timestamp) attempts.delete(candidate);
      while (attempts.size > 4096) attempts.delete(attempts.keys().next().value);
    }
    for (const { key, limit } of keys) {
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= timestamp) {
        attempts.set(key, { count: 0, resetAt: timestamp + LOGIN_WINDOW_MS });
      } else if (entry.count >= limit) throw new AccessError('login_rate_limited', 429);
    }
  }

  function recordLoginFailure(keys) {
    for (const { key } of keys) {
      const entry = attempts.get(key);
      if (entry) entry.count += 1;
    }
  }

  function consumeInvitationAttempt(request) {
    const timestamp = clock().getTime();
    for (const [candidate, value] of invitationAttempts) {
      if (value.resetAt <= timestamp) invitationAttempts.delete(candidate);
    }
    while (invitationAttempts.size > 2048) invitationAttempts.delete(invitationAttempts.keys().next().value);
    const key = requestAddress(request);
    const current = invitationAttempts.get(key);
    if (!current || current.resetAt <= timestamp) {
      invitationAttempts.set(key, { count: 1, resetAt: timestamp + LOGIN_WINDOW_MS });
      return;
    }
    if (current.count >= INVITATION_ADDRESS_ATTEMPTS) {
      throw new AccessError('invitation_rate_limited', 429);
    }
    current.count += 1;
  }

  function requireDeliveryReady() {
    if (requireInvitationDelivery && invitationDelivery === null) {
      throw new AccessError('invitation_email_unavailable', 503);
    }
  }

  async function deliverInvitation(result) {
    if (result.token === null) {
      return { delivery: { status: 'already_processed' }, invitationPath: null };
    }
    const path = invitePath(result.token);
    if (invitationDelivery === null) {
      return { delivery: { status: 'not_configured' }, invitationPath: path };
    }
    let status = 'unknown';
    try {
      const delivery = await invitationDelivery.send({ ...result.invitation, token: result.token });
      if (['accepted', 'failed', 'unknown'].includes(delivery?.status)) status = delivery.status;
    } catch {}
    return {
      delivery: { status },
      invitationPath: status === 'accepted' ? null : path,
    };
  }

  const passwordRecovery = require('./password-recovery-http').createPasswordRecoveryHttp({
    access, delivery: invitationDelivery, turnstile, requestAddress, clock,
  });

  async function route(request, response, url, { readJson, sendJson }) {
    // A DSP support context can edit only the selected DSP and the actor's own account.
    if (request.headers['x-dispatch-dsp-view'] !== undefined && !['GET', 'HEAD'].includes(request.method)
        && !url.pathname.startsWith('/api/organization/')
        && !/^\/api\/plugins\/[a-z][a-z0-9-]{0,63}\/[a-z][a-z0-9_.]{0,63}$/.test(url.pathname)
        && !['/api/paycom/sync', '/api/auth/logout', '/api/auth/change-password'].includes(url.pathname)) {
      throw new AccessError('dsp_view_scope', 403);
    }
    if (await passwordRecovery.route(request, response, url, { readJson, sendJson })) return true;
    if (request.method === 'POST' && url.pathname === '/api/platform/organization/view') {
      const current = session(request);
      requireMutation(request, current, url);
      const viewed = access.beginDspView(current, await readJson(request));
      sendJson(response, 200, { ok: true, status: 'viewing', data: publicSession(viewed), error: null });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/session') {
      sendJson(response, 200, { ok: true, status: 'ready', data: publicSession(session(request, { required: false })), error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/invitation/inspect') {
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AccessError('request_forbidden', 403);
      requireNoQuery(url);
      requireJson(request);
      const body = await readJson(request);
      exact(body, ['token']);
      consumeInvitationAttempt(request);
      sendJson(response, 200, { ok: true, status: 'found', data: access.inspectInvitation(body.token), error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AccessError('request_forbidden', 403);
      requireNoQuery(url);
      requireJson(request);
      const body = await readJson(request);
      exact(body, ['email', 'password', ...(turnstile ? ['turnstileToken'] : [])]);
      const keys = loginKeys(request, body);
      assertLoginAllowed(keys);
      if (turnstile) {
        try { await turnstile.verify(body.turnstileToken, 'login', requestAddress(request)); }
        catch (error) {
          if (error instanceof AccessError && error.statusCode < 500) recordLoginFailure(keys);
          throw error;
        }
      }
      const { turnstileToken, ...credentials } = body;
      try {
        const result = await access.signIn(credentials);
        attempts.delete(keys[0].key);
        sendJson(response, 200, { ok: true, status: 'authenticated', data: publicSession(result.session), error: null }, {
          'Set-Cookie': cookieHeader(sessionCookie, result.token, { maxAge: (result.expiresAt - clock().getTime()) / 1000, secure: secureCookies }),
        });
      } catch (error) {
        recordLoginFailure(keys);
        throw error;
      }
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AccessError('request_forbidden', 403);
      requireNoQuery(url);
      requireJson(request);
      const body = await readJson(request);
      exact(body, ['token', 'firstName', 'lastName', 'password', 'confirmPassword', ...(turnstile ? ['turnstileToken'] : [])]);
      consumeInvitationAttempt(request);
      if (turnstile) await turnstile.verify(body.turnstileToken, 'register', requestAddress(request));
      const { turnstileToken, ...registration } = body;
      const result = await access.acceptNewUser(registration);
      sendJson(response, 201, { ok: true, status: 'authenticated', data: publicSession(result.session), error: null }, {
        'Set-Cookie': cookieHeader(sessionCookie, result.token, { maxAge: (result.expiresAt - clock().getTime()) / 1000, secure: secureCookies }),
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/accept-invitation') {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      exact(body, ['token']);
      consumeInvitationAttempt(request);
      const updated = access.acceptExistingUser(current, body.token);
      sendJson(response, 200, { ok: true, status: 'accepted', data: publicSession(updated), error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/change-password') {
      const current = session(request);
      requireMutation(request, current, url);
      const result = await access.changePassword(current, await readJson(request));
      sendJson(response, 200, { ok: true, status: 'password_changed', data: publicSession(result.session), error: null }, {
        'Set-Cookie': cookieHeader(sessionCookie, result.token, { maxAge: (result.expiresAt - clock().getTime()) / 1000, secure: secureCookies }),
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/select-organization') {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      exact(body, ['membershipId']);
      const updated = access.selectMembership(current, body.membershipId);
      sendJson(response, 200, { ok: true, status: 'selected', data: publicSession(updated), error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      exact(body, []);
      access.signOut(current);
      sendJson(response, 200, { ok: true, status: 'signed_out', data: null, error: null }, {
        'Set-Cookie': cookieHeader(sessionCookie, '', { maxAge: 0, secure: secureCookies }),
      });
      return true;
    }

    if (url.pathname === '/api/organization/profile' && ['GET', 'POST'].includes(request.method)) {
      const current = session(request);
      requireNoQuery(url);
      if (request.method === 'POST') requireMutation(request, current, url);
      const result = access.organizationProfile(current, request.method === 'POST' ? await readJson(request) : undefined);
      sendJson(response, 200, { ok: true, status: 'found', data: result, error: null });
      return true;
    }
    if (url.pathname === '/api/platform/backups' && ['GET', 'POST'].includes(request.method)) {
      const current = session(request);
      requireNoQuery(url);
      access.requirePlatform(current, 'platform.installations.manage');
      if (!backups) throw new AccessError('installation_operator_disabled', 503);
      if (backups.ownerOnly && current.user.platformRole !== 'owner') throw new AccessError('platform_forbidden', 403);
      if (request.method === 'POST') {
        requireMutation(request, current, url);
        backups.command(current, await readJson(request));
      }
      sendJson(response, 200, { ok: true, status: 'found', data: backups.view(), error: null });
      return true;
    }
    if (url.pathname === '/api/updates/popup' && ['GET', 'POST'].includes(request.method)) {
      const current = session(request);
      requireNoQuery(url);
      let result;
      if (request.method === 'POST') {
        requireMutation(request, current, url);
        if (!releasePopup) throw new AccessError('release_popup_unavailable', 409);
        result = releasePopup.dismiss(current, await readJson(request));
      } else result = releasePopup?.pending(current) || { release: null };
      sendJson(response, 200, { ok: true, status: 'found', data: result, error: null });
      return true;
    }
    if (url.pathname === '/api/platform/updates' && ['GET', 'POST'].includes(request.method)) {
      const current = session(request);
      let releaseId = null;
      if (request.method === 'GET' && url.searchParams.has('releaseId')) {
        if ([...url.searchParams.keys()].length !== 1 || !/^[a-z][a-z0-9_.-]{2,95}$/.test(url.searchParams.get('releaseId'))) throw new AccessError('invalid_request', 400);
        releaseId = url.searchParams.get('releaseId');
      } else requireNoQuery(url);
      access.requirePlatform(current, 'platform.installations.manage');
      if (!updates) throw new AccessError('installation_operator_disabled', 503);
      if (updates.ownerOnly && (current.user.platformRole !== 'owner' || current.dspView)) throw new AccessError('platform_forbidden', 403);
      if (request.method === 'POST') {
        requireMutation(request, current, url);
        await updates.command(current, await readJson(request));
      }
      sendJson(response, 200, { ok: true, status: 'found', data: await updates.view(releaseId), error: null });
      return true;
    }

    if (url.pathname === '/api/platform/runtime' && request.method === 'GET') {
      const current = session(request);
      requireNoQuery(url);
      access.requirePlatform(current, 'platform.installations.manage');
      if (current.user.platformRole !== 'owner') throw new AccessError('platform_forbidden', 403);
      sendJson(response, 200, { ok: true, status: 'found', data: platformRuntime?.()
        || { enabled: false, storageAvailableBytes: null, runtimes: [] }, error: null });
      return true;
    }

    if (url.pathname === '/api/platform/diagnostics' && ['GET', 'POST'].includes(request.method)) {
      const current = session(request);
      requireNoQuery(url);
      if (request.method === 'POST') requireMutation(request, current, url);
      const result = access.platformDiagnostics(current, request.method === 'POST' ? await readJson(request) : undefined);
      sendJson(response, request.method === 'POST' ? 202 : 200, { ok: true, status: 'found', data: result, error: null });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/platform/organizations') {
      requireNoQuery(url);
      const current = session(request);
      sendJson(response, 200, { ok: true, status: 'found', data: access.platformOrganizations(current), error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/organizations') {
      const current = session(request);
      requireMutation(request, current, url);
      requireDeliveryReady();
      const result = access.createOrganization(current, await readJson(request));
      const handoff = await deliverInvitation(result);
      sendJson(response, result.replayed ? 200 : 201, {
        ok: true,
        status: result.replayed ? 'replayed' : 'created',
        data: {
          organization: {
            name: result.organization.name,
            abbreviation: result.organization.abbreviation,
            timezone: result.organization.timezone,
            stations: result.organization.stations,
            status: result.organization.status,
            installation: result.organization.installation,
          },
          ownerInvitation: {
            email: result.invitation.email,
            status: result.invitation.status,
            expiresAt: result.invitation.expiresAt,
          },
          invitationPath: handoff.invitationPath,
          delivery: handoff.delivery,
          replayed: result.replayed,
        },
        error: null,
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/organization/status') {
      const current = session(request);
      requireMutation(request, current, url);
      const result = access.setPlatformOrganizationSuspended(current, await readJson(request));
      sendJson(response, 200, { ok: true, status: result.status, data: result, error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/organization/owner-invitation') {
      const current = session(request);
      requireMutation(request, current, url);
      requireDeliveryReady();
      const result = access.createPlatformOwnerInvitation(current, await readJson(request));
      const handoff = await deliverInvitation(result);
      sendJson(response, result.replayed ? 200 : 201, {
        ok: true,
        status: result.replayed ? 'replayed' : 'created',
        data: {
          ownerInvitation: {
            email: result.invitation.email,
            status: result.invitation.status,
            expiresAt: result.invitation.expiresAt,
          },
          invitationPath: handoff.invitationPath,
          delivery: handoff.delivery,
          replayed: result.replayed,
        },
        error: null,
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/organization/owner-invitation/revoke') {
      const current = session(request);
      requireMutation(request, current, url);
      const result = access.revokePlatformOwnerInvitation(current, await readJson(request));
      sendJson(response, 200, { ok: true, status: result.status, data: result, error: null });
      return true;
    }

    if (request.method === 'POST' && ['/api/platform/installation/remove', '/api/platform/installation/delete', '/api/platform/installation/restore'].includes(url.pathname)) {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      const deleting = url.pathname.endsWith('/delete');
      const keys = deleting ? loginKeys(request, { email: current.user.email }) : null;
      if (keys) assertLoginAllowed(keys);
      let result;
      try {
        result = await access.requestPlatformRemoval(current, body,
          deleting ? 'destroy' : url.pathname.endsWith('/restore') ? 'resume' : 'decommission');
      } catch (error) {
        if (keys && error.code === 'current_password_invalid') recordLoginFailure(keys);
        throw error;
      }
      sendJson(response, 202, { ok: true, status: result.status, data: result, error: null });
      return true;
    }

    if (request.method === 'POST' && ['/api/platform/installation/suspend', '/api/platform/installation/resume',
      '/api/platform/installation/restart'].includes(url.pathname)) {
      const current = session(request);
      requireMutation(request, current, url);
      const result = access.requestPlatformRuntime(current, await readJson(request), url.pathname.split('/').at(-1));
      sendJson(response, 202, { ok: true, status: result.status, data: result, error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/installation/provision') {
      const current = session(request);
      requireMutation(request, current, url);
      const result = access.requestPlatformInstallationProvisioning(current, await readJson(request));
      sendJson(response, 202, { ok: true, status: result.status, data: result, error: null });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/platform/installation/retry') {
      const current = session(request);
      requireMutation(request, current, url);
      const result = access.requestPlatformInstallationRetry(current, await readJson(request));
      sendJson(response, 202, { ok: true, status: result.status, data: result, error: null });
      return true;
    }

    if (url.pathname === '/api/platform/plugins' && request.method === 'GET') {
      requireNoQuery(url);
      const current = session(request); access.requirePlatform(current, 'platform.organizations.read');
      if (!plugins) throw new AccessError('plugin_unavailable', 503);
      sendJson(response, 200, { ok: true, status: 'found', data: plugins.catalog(), error: null });
      return true;
    }
    if (url.pathname === '/api/organization/plugins' && request.method === 'GET') {
      requireNoQuery(url);
      const current = session(request);
      if (!plugins) throw new AccessError('plugin_unavailable', 503);
      sendJson(response, 200, { ok: true, status: 'found', data: plugins.list(current), error: null });
      return true;
    }
    const settingsRoute = url.pathname.match(/^\/api\/organization\/plugins\/([a-z][a-z0-9-]{0,63})\/settings(\/options|\/history)?$/);
    if (settingsRoute && (request.method === 'GET' || request.method === 'POST' && !settingsRoute[2])) {
      let historyInput;
      if (settingsRoute[2] === '/history') {
        if ([...url.searchParams.keys()].some(key=>key!=='before') || url.searchParams.getAll('before').length>1) throw new AccessError('invalid_input',400);
        const before=url.searchParams.get('before');
        if(before!==null && (!/^(0|[1-9][0-9]{0,15})$/.test(before) || !Number.isSafeInteger(Number(before))))throw new AccessError('invalid_input',400);
        historyInput={beforeRevision:before===null?null:Number(before)};
      } else requireNoQuery(url);
      const current = session(request);
      if (!plugins?.settings) throw new AccessError('settings_unavailable',503);
      if (request.method === 'POST') requireMutation(request,current,url);
      const data = await plugins.settings(current,settingsRoute[1],request.method === 'POST' ? 'update' : settingsRoute[2] === '/history' ? 'history' : settingsRoute[2] ? 'options' : 'get',
        request.method === 'POST' ? await readJson(request) : historyInput);
      session(request);
      sendJson(response,200,{ok:true,status:'found',data,error:null});return true;
    }
    const pluginRoute = url.pathname.match(/^\/api\/organization\/plugins\/([a-z][a-z0-9-]{0,63})$/);
    if (pluginRoute && request.method === 'POST') {
      const current = session(request); requireMutation(request, current, url);
      if (!plugins) throw new AccessError('plugin_unavailable', 503);
      const data = plugins.change(current, pluginRoute[1], await readJson(request));
      sendJson(response, 202, { ok: true, status: 'accepted', data, error: null });
      return true;
    }

    if (url.pathname === '/api/organization/connections' && request.method === 'GET') {
      requireNoQuery(url);
      const current = session(request);
      access.requireDspOwner(current);
      if (!connections) throw new AccessError('auth_unavailable', 503);
      const data = await connections.list(current);
      sendJson(response, 200, { ok: true, status: 'found', data: { ...data, services: connections.services.filter(service => data.items.some(item => item.service === service.id)) }, error: null });
      return true;
    }
    const connectionRoute = url.pathname.match(/^\/api\/organization\/connections\/([a-z][a-z0-9-]{0,63})\/(save|test|disconnect|verify)$/);
    if (connectionRoute && request.method === 'POST') {
      requireNoQuery(url);
      const current = session(request);
      requireMutation(request, current, url);
      access.requireDspOwner(current);
      if (!connections) throw new AccessError('auth_unavailable', 503);
      const data = await connections.change(current, connectionRoute[1], connectionRoute[2],
        await readJson(request, require('../../shared/contracts/src/connections').CONNECTION_REQUEST_MAX_BYTES));
      sendJson(response, 202, { ok: true, status: 'accepted', data, error: null });
      return true;
    }
    if (url.pathname === '/api/organization/paycom-setup' && ['GET', 'POST'].includes(request.method)) {
      requireNoQuery(url);
      const current = session(request);
      require('../accounts/src/plugins').requirePlugin(access, current, 'paycom');
      if (!paycomSetup) throw new AccessError('installation_operator_disabled', 503);
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, status: 'found', data: await paycomSetup.status(current), error: null });
      } else {
        requireMutation(request, current, url);
        const result = await paycomSetup.submit(current, await readJson(request));
        sendJson(response, 202, { ok: true, status: 'accepted', data: result, error: null });
      }
      return true;
    }
    if (url.pathname === '/api/organization/paycom-setup/retry' && request.method === 'POST') {
      const current = session(request);
      requireMutation(request, current, url);
      require('../accounts/src/plugins').requirePlugin(access, current, 'paycom');
      if (!paycomSetup) throw new AccessError('installation_operator_disabled', 503);
      const result = await paycomSetup.retry(current, await readJson(request));
      sendJson(response, 200, { ok: true, status: 'accepted', data: result, error: null });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/organization/setup') {
      requireNoQuery(url);
      const current = session(request);
      sendJson(response, 200, { ok: true, status: 'found', data: access.organizationSetup(current), error: null });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/organization/audit') {
      requireNoQuery(url);
      const current = session(request);
      sendJson(response, 200, { ok: true, status: 'found', data: access.organizationAudit(current, activeOrganizationId(current)), error: null });
      return true;
    }

    let match = /^\/api\/organization\/administration$/.exec(url.pathname);
    if (request.method === 'GET' && match) {
      requireNoQuery(url);
      const current = session(request);
      sendJson(response, 200, { ok: true, status: 'found', data: access.organizationAdministration(current, activeOrganizationId(current)), error: null });
      return true;
    }

    match = /^\/api\/organization\/roles$/.exec(url.pathname);
    if (request.method === 'POST' && match) {
      const current = session(request);
      requireMutation(request, current, url);
      const role = access.createRole(current, activeOrganizationId(current), await readJson(request));
      sendJson(response, 201, { ok: true, status: 'created', data: role, error: null });
      return true;
    }

    match = /^\/api\/organization\/roles\/([a-z][a-z0-9_-]{2,95})$/.exec(url.pathname);
    if (request.method === 'PUT' && match) {
      const current = session(request);
      requireMutation(request, current, url);
      const role = access.updateRole(current, activeOrganizationId(current), match[1], await readJson(request));
      sendJson(response, 200, { ok: true, status: 'updated', data: role, error: null });
      return true;
    }
    if (request.method === 'DELETE' && match) {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      exact(body, []);
      access.deleteRole(current, activeOrganizationId(current), match[1]);
      sendJson(response, 200, { ok: true, status: 'deleted', data: null, error: null });
      return true;
    }

    match = /^\/api\/organization\/invitations$/.exec(url.pathname);
    if (request.method === 'POST' && match) {
      const current = session(request);
      requireMutation(request, current, url);
      requireDeliveryReady();
      const result = access.createMemberInvitation(current, activeOrganizationId(current), await readJson(request));
      const handoff = await deliverInvitation(result);
      sendJson(response, 201, {
        ok: true, status: 'created',
        data: {
          invitation: result.invitation,
          invitationPath: handoff.invitationPath,
          delivery: handoff.delivery,
        },
        error: null,
      });
      return true;
    }

    match = /^\/api\/organization\/invitations\/([a-z][a-z0-9_-]{2,95})$/.exec(url.pathname);
    if (request.method === 'DELETE' && match) {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      exact(body, []);
      access.revokeMemberInvitation(current, activeOrganizationId(current), match[1]);
      sendJson(response, 200, { ok: true, status: 'revoked', data: null, error: null });
      return true;
    }

    match = /^\/api\/organization\/members\/([a-z][a-z0-9_-]{2,95})\/role$/.exec(url.pathname);
    if (request.method === 'PUT' && match) {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      exact(body, ['roleId']);
      access.updateMemberRole(current, activeOrganizationId(current), match[1], body.roleId);
      sendJson(response, 200, { ok: true, status: 'updated', data: null, error: null });
      return true;
    }

    match = /^\/api\/organization\/members\/([a-z][a-z0-9_-]{2,95})$/.exec(url.pathname);
    if (request.method === 'DELETE' && match) {
      const current = session(request);
      requireMutation(request, current, url);
      const body = await readJson(request);
      exact(body, []);
      access.removeMember(current, activeOrganizationId(current), match[1]);
      sendJson(response, 200, { ok: true, status: 'deleted', data: null, error: null });
      return true;
    }

    return false;
  }

  return { route, session, requireMutation, publicSession };
}

module.exports = {
  SESSION_COOKIE: LOCAL_SESSION_COOKIE,
  PUBLIC_SESSION_COOKIE,
  cookieHeader,
  sessionToken,
  invitePath,
  createAccessHttp,
};
