'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AccessStore, AccessControlService } = require('../../core/accounts/src');
const { createDashboardServer, sourceDate, publicSyncView } = require('../server/server');
const { parseArguments } = require('../server/main');

const COLLECTED = '2026-08-30T18:00:00.000Z';

test('private installation control is an explicit capability separate from sync operation', () => {
  assert.deepEqual(parseArguments(['--operator', '--installation-operator']), {
    host: '127.0.0.1', port: 4310, operator: true, installationOperator: true,
    installationBackend: 'native_service_v1', secureCookies: false, publicOrigin: null,
  });
  assert.equal(parseArguments([
    '--secure-cookies', '--public-origin', 'https://dispatch.example.test',
  ]).publicOrigin, 'https://dispatch.example.test');
  assert.throws(() => parseArguments(['--public-origin', 'https://dispatch.example.test']));
  assert.equal(parseArguments(['--secure-cookies', '--public-origin', 'https://other.example']).publicOrigin, 'https://other.example');
  assert.throws(() => parseArguments(['--secure-cookies', '--public-origin', 'https://other.example/path']));
  assert.equal(parseArguments([]).installationOperator, false);
  assert.equal(parseArguments(['--installation-backend', 'oci_container_v1']).installationBackend,
    'oci_container_v1');
  assert.throws(() => parseArguments(['--installation-backend', 'unknown']));
  assert.throws(() => parseArguments(['--installation-backend', 'systemd_user']));
  const serviceTemplate = fs.readFileSync(
    path.join(__dirname, "../integration/systemd/dispatch-dashboard.service.in"), 'utf8',
  );
  assert.doesNotMatch(serviceTemplate, /--installation-operator/);
  assert.match(serviceTemplate, /--secure-cookies --public-origin \$\{DISPATCH_PUBLIC_ORIGIN\}/);
});

test('public origin enforces canonical host, mutation origin, and secure cookies', async t => {
  const origin = 'https://dispatch.example.test';
  const running = await runningServer({ secureCookies: true, publicOrigin: origin });
  t.after(running.close);
  const cloudflareHttps = { 'CF-Visitor': '{"scheme":"https"}' };
  const request = ({ pathname, method = 'GET', headers = {}, body = null }) => new Promise((resolve, reject) => {
    const local = http.request(new URL(pathname, running.base), { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    local.once('error', reject);
    if (body !== null) local.end(body); else local.end();
  });

  const wrongHost = await request({
    pathname: '/api/auth/session', headers: { Host: 'untrusted.example', ...cloudflareHttps },
  });
  assert.equal(wrongHost.status, 403);

  const page = await request({
    pathname: '/', headers: { Host: 'dispatch.example.test', ...cloudflareHttps },
  });
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['strict-transport-security'], 'max-age=31536000');

  const insecurePage = await request({
    pathname: '/api/auth/session?probe=1',
    headers: { Host: 'dispatch.example.test', 'CF-Visitor': '{"scheme":"http"}' },
  });
  assert.equal(insecurePage.status, 308);
  assert.equal(insecurePage.headers.location, `${origin}/api/auth/session?probe=1`);

  const credentials = JSON.stringify({
    email: 'owner@example.test', password: 'correct horse battery staple',
  });
  const missingOrigin = await request({
    pathname: '/api/auth/login',
    method: 'POST',
    headers: { Host: 'dispatch.example.test', 'Content-Type': 'application/json', ...cloudflareHttps },
    body: credentials,
  });
  assert.equal(missingOrigin.status, 403);

  const login = await request({
    pathname: '/api/auth/login',
    method: 'POST',
    headers: {
      Host: 'dispatch.example.test', Origin: origin, 'Content-Type': 'application/json', ...cloudflareHttps,
    },
    body: credentials,
  });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /^__Host-dispatch_session=/);
  assert.match(login.headers['set-cookie'][0], /; Path=\/; HttpOnly; SameSite=Strict;/);
  assert.match(login.headers['set-cookie'][0], /; Secure/);
  assert.doesNotMatch(login.headers['set-cookie'][0], /; Domain=/i);

  const authenticated = JSON.parse(login.body).data;
  const publicCookie = login.headers['set-cookie'][0].split(';')[0];
  const publicHeaders = {
    Host: 'dispatch.example.test',
    Origin: origin,
    'Content-Type': 'application/json',
    'X-Dispatch-CSRF': authenticated.csrfToken,
    Cookie: publicCookie,
    ...cloudflareHttps,
  };
  const before = JSON.parse((await request({
    pathname: '/api/platform/organizations',
    headers: { Host: 'dispatch.example.test', Cookie: publicCookie, ...cloudflareHttps },
  })).body).data.length;
  const unavailable = await request({
    pathname: '/api/platform/organizations',
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({
      idempotencyKey: 'dashboard:organization:email-required',
      name: 'Must Not Exist', abbreviation: null, stationCode: 'DWA9',
      timezone: 'America/Los_Angeles', ownerEmail: 'blocked@example.test',
    }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.parse(unavailable.body).status, 'invitation_email_unavailable');
  const after = JSON.parse((await request({
    pathname: '/api/platform/organizations',
    headers: { Host: 'dispatch.example.test', Cookie: publicCookie, ...cloudflareHttps },
  })).body).data.length;
  assert.equal(after, before);
});

test('email-only creation reports disabled provisioning without creating records or sending mail', async t => {
  const deliveries = [];
  const running = await runningServer({ platformOnly: true, invitationDelivery: {
    send: async value => { deliveries.push(value); return { status: 'accepted' }; },
  } });
  t.after(running.close);
  const before = running.store.db.prepare('SELECT count(*) AS count FROM invitations').get().count;
  const create = () => fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST',
    headers: { Cookie: running.cookie, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify({ idempotencyKey: 'dashboard:organization:disabled', ownerEmail: 'new-owner@example.test' }),
  });
  const response = await create();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'installation_operator_disabled');
  assert.equal(running.store.db.prepare('SELECT count(*) AS count FROM organizations').get().count, 0);
  assert.equal(running.store.db.prepare('SELECT count(*) AS count FROM invitations').get().count, before);
  assert.equal(deliveries.length, 0);

  // Only the explicit AccessError allowlist is public; unexpected 5xx details stay private.
  for (const error of [
    Object.assign(new Error('private database path'), { statusCode: 503, code: 'installation_operator_disabled' }),
    new (require('../../core/accounts/src').AccessError)('private_internal_failure', 503),
  ]) {
    running.access.createOrganization = () => { throw error; };
    const failure = await create();
    assert.equal(failure.status, 503);
    const payload = await failure.json();
    assert.equal(payload.error.code, 'dashboard_unavailable');
    assert.doesNotMatch(JSON.stringify(payload), /private|installation_operator_disabled/);
  }
});

test('dashboard failure views discard upstream details and raw exception messages', async t => {
  assert.deepEqual(publicSyncView({
    ok: false,
    status: 'sync_unavailable',
    error: { code: 'sync_unavailable', recoverable: true, detail: '/private/runtime' },
    data: null,
  }), {
    ok: false, status: 'sync_unavailable',
    error: { code: 'sync_unavailable', recoverable: true }, data: null,
  });
  assert.deepEqual(publicSyncView({
    ok: false, status: '/private/runtime', error: { code: '/private/runtime' }, data: null,
  }), {
    ok: false, status: 'sync_unavailable',
    error: { code: 'sync_unavailable', recoverable: false }, data: null,
  });

  const client = fixtureClient();
  client.workforce.day = async () => { throw Object.assign(new Error('/private/runtime'), { statusCode: 400 }); };
  const running = await runningServer({ client });
  t.after(running.close);
  const response = await fetch(`${running.base}/api/paycom/daily?date=2026-08-30`, {
    headers: { Cookie: running.cookie },
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.status, 'invalid_input');
  assert.equal(JSON.stringify(body).includes('/private/runtime'), false);
});

function fixtureClient() {
  const calls = [];
  const syncData = {
    id: 'paycom-main-workforce', desiredState: 'running', activity: 'idle',
    lastSucceededAt: COLLECTED, lastError: null,
    businessContext: { date: '2026-08-30', timezone: 'America/Los_Angeles' },
    alerts: [], activeRun: null, queuedRunCount: 0,
  };
  return {
    calls,
    workforce: {
      day: async query => {
        calls.push(['day', query]);
        return {
          contractVersion: 1, ok: true, status: 'found',
          data: {
            kind: 'workforce_day', target: '2026-09-05', businessDate: query.date,
            businessTimezone: 'America/Los_Angeles', periodStart: '2026-08-23', periodEnd: '2026-09-05',
            available: true, collectedAt: COLLECTED,
            summary: {
              employees: 1, activeEmployees: 1, inDayPunches: 1, completeTimecards: 0,
              needsReview: 0, noActivity: 0, missingOutDay: 1, incompleteLunch: 0, unclassifiedPunches: 0,
            },
            items: [{ employeeCode: 'A001', employeeName: 'Fixture Employee' }],
            total: 1, limit: query.limit, offset: query.offset, hasMore: false,
          },
        };
      },
    },
    sync: {
      status: async id => {
        calls.push(['sync.status', id]);
        return { contractVersion: 1, ok: true, status: 'found', data: syncData };
      },
      runNow: async (id, options) => {
        calls.push(['sync.runNow', id, options]);
        return { contractVersion: 1, ok: true, status: 'queued', data: { sync: syncData, run: null } };
      },
    },
    system: {
      status: async () => ({
        contractVersion: 1, ok: true, status: 'degraded',
        data: {
          components: {
            auth: { healthy: false, ready: false, status: 'stopped', data: null, error: null },
            collections: { healthy: true, ready: false, status: 'stopped', data: { counts: { queued: 0, running: 0 } }, error: null },
            paycom: { healthy: true, ready: true, status: 'ready', data: {}, error: null },
          },
          summary: { ready: 1, degraded: 2, failed: 0 },
        },
      }),
    },
  };
}

async function runningServer(options = {}) {
  const client = options.client || fixtureClient();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-dashboard-access-'));
  fs.chmodSync(root, 0o700);
  const store = new AccessStore({
    databaseRoot: path.join(root, 'access-control'),
    database: path.join(root, 'access-control', 'access-control.sqlite3'),
  });
  const now = () => new Date('2026-09-01T12:00:00.000Z');
  const access = new AccessControlService(store, {
    clock: now,
    installationOperatorEnabled: options.installationOperator ?? false,
    ...(options.installationBackend ? { installationBackend: options.installationBackend } : {}),
  });
  if (!options.platformOnly) access.ensureLocalOrganization({
    organization: { id: 'local-dsp', name: 'Fixture DSP' },
    site: { id: 'local-site', code: 'TST1' },
    timezone: 'America/Los_Angeles',
  });
  if (!options.platformOnly) require('../../core/accounts/tests/plugin-fixture').enableFixturePlugin(store, 'local-dsp');
  const invitation = access.createPlatformBootstrap({ email: 'owner@example.test', organizationId: options.platformOnly ? null : 'local-dsp' });
  const authenticated = await access.acceptNewUser({
    token: invitation.token, firstName: 'Fixture', lastName: 'Owner',
    password: 'correct horse battery staple', confirmPassword: 'correct horse battery staple',
  });
  // These legacy tenant API tests explicitly select their existing DSP membership.
  if (!options.platformOnly) access.selectMembership(authenticated.session, authenticated.session.memberships[0].id);
  const server = createDashboardServer({
    client,
    access,
    publicRoot: options.publicRoot,
    coreIdentity: options.coreIdentity,
    coreMaintenance: options.coreMaintenance,
    operator: options.operator ?? false,
    secureCookies: options.secureCookies ?? false,
    publicOrigin: options.publicOrigin ?? null,
    invitationDelivery: options.invitationDelivery ?? null,
    turnstile: options.turnstile ?? null,
    paycomSetup: options.paycomInvoke ? require('../../core/accounts/src/owner-paycom-setup').createOwnerPaycomSetup({
      store, access, invoke: options.paycomInvoke, clock: () => now().getTime(),
    }) : null,
    connections: options.connectionsInvoke ? require('../../core/accounts/src/owner-connections').createOwnerConnections({
      store, access, invoke: options.connectionsInvoke, clock: () => now().getTime(),
    }) : null,
    backups: options.backups ? require('../../core/accounts/src/platform-backups').createPlatformBackups({store,enabled:true}) : null,
    updates: options.updates ? require('../../core/accounts/src/platform-updates').createPlatformUpdates({
      store, releases: { dispatch_update_2: {} }, platformReleases: { dispatch_update_2: { version: '0.0.2', publishedAt: '2026-09-05T00:00:00.000Z', changelog: [], core: {} } }, enabled: true,
    }) : null,
    now,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    access,
    store,
    client,
    server,
    cookie: `dispatch_session=${authenticated.token}`,
    csrfToken: authenticated.session.csrfToken,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); resolve(); })),
  };
}

test('dashboard serves the secure application shell and a source-local bootstrap', async t => {
  const running = await runningServer();
  t.after(running.close);
  const page = await fetch(`${running.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /<div id="root"><\/div>/);

  const anonymous = await (await fetch(`${running.base}/api/auth/session`)).json();
  assert.equal(anonymous.data.authenticated, false);
  const blocked = await fetch(`${running.base}/api/bootstrap`);
  assert.equal(blocked.status, 401);
  const authenticated = await (await fetch(`${running.base}/api/auth/session`, { headers: { Cookie: running.cookie } })).json();
  assert.equal(authenticated.data.authenticated, true);
  assert.equal(authenticated.data.memberships[0].organization.id, 'local-dsp');
  assert.equal(JSON.stringify(authenticated).includes('runtimeKey'), false);

  const bootstrap = await (await fetch(`${running.base}/api/bootstrap`, { headers: { Cookie: running.cookie } })).json();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.data.today, '2026-09-01');
  assert.equal(bootstrap.data.timezone, 'America/Los_Angeles');
  assert.equal(bootstrap.data.operatorActions, false);
  assert.equal(typeof bootstrap.data.csrfToken, 'string');
  assert.equal(sourceDate(new Date('2026-09-01T02:00:00.000Z'), 'America/Los_Angeles'), '2026-08-31');
});

test('shell references content-addressed assets with matching GET and HEAD responses', async t => {
  const running = await runningServer();
  t.after(running.close);
  const page = await fetch(`${running.base}/`);
  const html = await page.text();
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const normalizeNonce = value => value.replace(/(<meta name="dispatch-style-nonce" content=")[^"]+/, '$1NONCE');
  assert.equal(normalizeNonce(await (await fetch(`${running.base}/index.html`)).text()), normalizeNonce(html));
  const nonce = html.match(/name="dispatch-style-nonce" content="([^"]+)/)[1];
  assert.ok(page.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
  assert.ok(!page.headers.get('content-security-policy').includes("'unsafe-inline'"));
  const urls = [...html.matchAll(/(?:href|src)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.deepEqual(urls.map(url => url.split('/').pop().split('.')[0]), [
    'updates', 'backups', 'launcher',
  ]);
  for (const url of urls) {
    assert.match(url, /^\/assets\/(frontend|updates|backups|styles|launcher)\.[a-f0-9]{64}\.(js|css)$/);
    const response = await fetch(`${running.base}${url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    assert.equal(url.includes(digest), true);
    const head = await fetch(`${running.base}${url}`, { method: 'HEAD' });
    assert.equal(await head.text(), '');
    for (const header of ['content-type', 'content-length', 'cache-control']) {
      assert.equal(head.headers.get(header), response.headers.get(header));
    }
    const legacyUrl = url.replace(/\.[a-f0-9]{64}\./, '.');
    const legacy = await fetch(`${running.base}${legacyUrl}`);
    assert.equal(legacy.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), bytes);
  }
  assert.equal((await fetch(`${running.base}/assets/styles.${'0'.repeat(64)}.css`)).status, 404);
});

test('deployments bypass previously cached assets and keep each running shell consistent', async t => {
  const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-dashboard-assets-'));
  t.after(() => fs.rmSync(publicRoot, { recursive: true, force: true }));
  fs.cpSync(path.join(__dirname, "../public"), publicRoot, { recursive: true });
  const before = await runningServer({ publicRoot });
  t.after(before.close);
  const htmlBefore = await (await fetch(`${before.base}/`)).text();
  const styleUrl = html => html.match(/src="([^\"]*launcher[^\"]+\.js)"/)[1];
  const urlBefore = styleUrl(htmlBefore);
  const cssBefore = await (await fetch(`${before.base}${urlBefore}`)).text();
  // Model the still-fresh browser cache retained across a deployment.
  const cache = new Map([['/assets/launcher.js', cssBefore], [urlBefore, cssBefore]]);
  fs.appendFileSync(path.join(publicRoot, 'assets/launcher.js'), '\n// next launcher build\n');
  const normalizeNonce = value => value.replace(/(<meta name="dispatch-style-nonce" content=")[^"]+/, '$1NONCE');
  assert.equal(normalizeNonce(await (await fetch(`${before.base}/`)).text()), normalizeNonce(htmlBefore));
  assert.equal(await (await fetch(`${before.base}${urlBefore}`)).text(), cssBefore);
  const after = await runningServer({ publicRoot });
  t.after(after.close);
  const urlAfter = styleUrl(await (await fetch(`${after.base}/`)).text());
  assert.notEqual(urlAfter, urlBefore);
  assert.equal(cache.has(urlAfter), false);
  const cssAfter = await (await fetch(`${after.base}${urlAfter}`)).text();
  assert.equal(cssAfter, fs.readFileSync(path.join(publicRoot, 'assets/launcher.js'), 'utf8'));
});

test('shared login supports platform-only accounts and CLI recovery without a DSP or runtime', async t => {
  const running = await runningServer({ platformOnly: true, updates: true });
  t.after(running.close);
  const session = await (await fetch(`${running.base}/api/auth/session`, { headers: { Cookie: running.cookie } })).json();
  assert.equal(session.data.activeOrganizationId, null);
  assert.deepEqual(session.data.memberships, []);
  assert.equal(running.store.organizations().length, 0);
  const headers = { Cookie: running.cookie };
  assert.equal((await fetch(`${running.base}/api/platform/organizations`, { headers })).status, 200);
  assert.equal((await fetch(`${running.base}/api/platform/updates`, { headers })).status, 200);
  assert.equal((await fetch(`${running.base}/api/bootstrap`, { headers })).status, 409);
  assert.equal(running.client.calls.length, 0, 'platform login must not call a DSP runtime');
  const { administerOwner } = require('../../core/accounts/src/owner-admin');
  await administerOwner(running.store, 'owner-recover', { email: 'owner@example.test', newEmail: 'recovered@example.test',
    password: 'new platform recovery password', confirmPassword: 'new platform recovery password' });
  assert.equal((await fetch(`${running.base}/api/platform/organizations`, { headers })).status, 401);
  const login = await fetch(`${running.base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: running.base },
    body: JSON.stringify({ email: 'recovered@example.test', password: 'new platform recovery password' }) });
  assert.equal(login.status, 200);
  const recovered = await login.json();
  assert.equal(recovered.data.activeOrganizationId, null);
  assert.deepEqual(recovered.data.memberships, []);
});

test('platform organization and owner controls use opaque session-bound references', async t => {
  const running = await runningServer();
  t.after(running.close);
  const login = await fetch(`${running.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);

  const createBody = {
    idempotencyKey: 'dashboard:organization:create:second',
    name: 'Second DSP', abbreviation: 'SDSP', stationCode: 'DWA1',
    timezone: 'America/Los_Angeles', ownerEmail: 'second-owner@example.test',
  };
  const provisioned = await fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify(createBody),
  });
  const created = await provisioned.json();
  assert.equal(provisioned.status, 201);
  assert.equal(Object.hasOwn(created.data.organization, 'id'), false);
  assert.equal(JSON.stringify(created).includes('runtimeKey'), false);
  const invitationToken = /^#\/invitation\/([A-Za-z0-9_-]{43})$/.exec(new URL(created.data.invitationPath, running.base).hash)?.[1];
  assert.equal(typeof invitationToken, 'string');
  const replay = await (await fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify(createBody),
  })).json();
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.data.invitationPath, null);

  const registration = await fetch(`${running.base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: invitationToken, firstName: 'Second', lastName: 'Owner',
      password: 'second owner secure password', confirmPassword: 'second owner secure password',
    }),
  });
  assert.equal(registration.status, 201);
  let ownerCookie = registration.headers.get('set-cookie').split(';')[0];
  const organizations = await (await fetch(`${running.base}/api/platform/organizations`, {
    headers: { Cookie: running.cookie },
  })).json();
  const second = organizations.data.find(item => item.name === 'Second DSP');
  assert.match(second.controlRef, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second.continuityRef, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(second, 'id'), false);
  assert.equal(JSON.stringify(second).includes('runtimeKey'), false);
  assert.equal(second.availableActions.includes('suspend'), false);
  assert.deepEqual(second.installation.availableActions, []);
  const disabledProvision = await fetch(`${running.base}/api/platform/installation/provision`, {
    method: 'POST',
    headers: { Cookie: running.cookie, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify({
      controlRef: second.controlRef,
      idempotencyKey: 'dashboard:installation:disabled:second',
      expectedRevision: second.installation.revision,
    }),
  });
  assert.equal(disabledProvision.status, 503);

  const suspended = await fetch(`${running.base}/api/platform/organization/status`, {
    method: 'POST',
    headers: { Cookie: running.cookie, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify({
      controlRef: second.controlRef, idempotencyKey: 'dashboard:organization:suspend:second', suspended: true,
    }),
  });
  assert.equal(suspended.status, 200);
  const suspendedProjection = (await (await fetch(`${running.base}/api/platform/organizations`, {
    headers: { Cookie: running.cookie },
  })).json()).data.find(item => item.name === 'Second DSP');
  assert.equal(suspendedProjection.availableActions.includes('resume'), false);
  assert.equal((await fetch(`${running.base}/api/organization/administration`, { headers: { Cookie: ownerCookie } })).status, 401);
  const resumed = await fetch(`${running.base}/api/platform/organization/status`, {
    method: 'POST',
    headers: { Cookie: running.cookie, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify({
      controlRef: second.controlRef, idempotencyKey: 'dashboard:organization:resume:second', suspended: false,
    }),
  });
  assert.equal(resumed.status, 200);
  assert.equal((await fetch(`${running.base}/api/organization/administration`, { headers: { Cookie: ownerCookie } })).status, 401);
  const relogin = await fetch(`${running.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: createBody.ownerEmail, password: 'second owner secure password' }) });
  assert.equal(relogin.status, 200);
  ownerCookie = relogin.headers.get('set-cookie').split(';')[0];
  const ownerAdministration = await fetch(`${running.base}/api/organization/administration`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerAdministration.status, 200);
  const ownerAdministrationBody = await ownerAdministration.json();
  assert.notEqual(ownerAdministrationBody.data.organization.id, 'local-dsp');
  assert.equal(ownerAdministrationBody.data.organization.name, 'Second DSP');
  const tenantOverride = await fetch(`${running.base}/api/organization/administration?organizationId=local-dsp`, { headers: { Cookie: ownerCookie } });
  assert.equal(tenantOverride.status, 400);
  const legacyPlatformPath = await fetch(`${running.base}/api/platform/organizations/local-dsp/status`, {
    method: 'POST', headers: { Cookie: running.cookie, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': running.csrfToken }, body: '{}',
  });
  assert.equal(legacyPlatformPath.status, 405);
  const pendingRuntime = await fetch(`${running.base}/api/bootstrap`, { headers: { Cookie: ownerCookie } });
  assert.equal(pendingRuntime.status, 409);
});

test('invitation email uses authoritative fields, hides accepted links, and does not resend replays', async t => {
  const deliveries = [];
  const running = await runningServer({
    invitationDelivery: {
      send: async value => {
        deliveries.push(value);
        return { status: value.email.startsWith('unknown-') ? 'unknown' : 'accepted' };
      },
    },
  });
  t.after(running.close);
  const headers = {
    'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken,
  };
  const acceptedRequest = {
    idempotencyKey: 'dashboard:organization:create:emailed',
    name: 'Emailed DSP', abbreviation: 'MAIL', stationCode: 'DWA2',
    timezone: 'America/New_York', ownerEmail: 'emailed-owner@example.test',
  };
  const acceptedResponse = await fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST', headers, body: JSON.stringify(acceptedRequest),
  });
  const accepted = await acceptedResponse.json();
  assert.equal(acceptedResponse.status, 201);
  assert.deepEqual(accepted.data.delivery, { status: 'accepted' });
  assert.equal(accepted.data.invitationPath, null);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].email, acceptedRequest.ownerEmail);
  assert.equal(deliveries[0].organizationName, acceptedRequest.name);
  assert.equal(deliveries[0].roleName, 'Owner');
  assert.match(deliveries[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(accepted).includes(deliveries[0].token), false);

  const replay = await (await fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST', headers, body: JSON.stringify(acceptedRequest),
  })).json();
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(replay.data.delivery, { status: 'already_processed' });
  assert.equal(replay.data.invitationPath, null);
  assert.equal(deliveries.length, 1);

  const unknownRequest = {
    idempotencyKey: 'dashboard:organization:create:email-unknown',
    name: 'Unknown Delivery DSP', abbreviation: null, stationCode: 'DWA3',
    timezone: 'America/Chicago', ownerEmail: 'unknown-owner@example.test',
  };
  const unknownResponse = await fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST', headers, body: JSON.stringify(unknownRequest),
  });
  const unknown = await unknownResponse.json();
  assert.equal(unknownResponse.status, 201);
  assert.deepEqual(unknown.data.delivery, { status: 'unknown' });
  assert.match(unknown.data.invitationPath, /^\/#\/invitation\/[A-Za-z0-9_-]{43}$/);
  assert.equal(deliveries.length, 2);
  assert.equal(unknown.data.invitationPath.endsWith(deliveries[1].token), true);
});

test('platform provisioning request and owner setup status remain browser-safe and runtime-free', async t => {
  const running = await runningServer({ installationOperator: true });
  t.after(running.close);
  const createdResponse = await fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify({
      idempotencyKey: 'dashboard:organization:create:setup',
      name: 'Setup DSP', abbreviation: 'SETUP', stationCode: 'DWA6',
      timezone: 'America/Chicago', ownerEmail: 'setup-owner@example.test',
    }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  const invitationToken = /^#\/invitation\/([A-Za-z0-9_-]{43})$/.exec(
    new URL(created.data.invitationPath, running.base).hash,
  )?.[1];
  assert.equal(typeof invitationToken, 'string');
  const inspectedInvitation = await (await fetch(`${running.base}/api/auth/invitation/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: invitationToken }),
  })).json();
  assert.equal(Object.hasOwn(inspectedInvitation.data, 'id'), false);
  assert.equal(Object.hasOwn(inspectedInvitation.data.organization, 'id'), false);
  assert.equal(Object.hasOwn(inspectedInvitation.data.role, 'id'), false);
  const ownerRegistration = await fetch(`${running.base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: invitationToken, firstName: 'Setup', lastName: 'Owner',
      password: 'setup owner secure password', confirmPassword: 'setup owner secure password',
    }),
  });
  const ownerCookie = ownerRegistration.headers.get('set-cookie').split(';')[0];
  const setup = await (await fetch(`${running.base}/api/organization/setup`, {
    headers: { Cookie: ownerCookie },
  })).json();
  assert.equal(setup.data.installationState, 'pending');
  assert.equal(setup.data.setupState, 'waiting_for_platform');
  assert.equal(setup.data.operationalAccess, 'unavailable');
  assert.equal(JSON.stringify(setup).includes('runtimeKey'), false);
  assert.equal((await fetch(`${running.base}/api/organization/setup?organizationId=local-dsp`, {
    headers: { Cookie: ownerCookie },
  })).status, 400);
  assert.equal((await fetch(`${running.base}/api/organization/setup`)).status, 401);

  const organizations = await (await fetch(`${running.base}/api/platform/organizations`, {
    headers: { Cookie: running.cookie },
  })).json();
  const row = organizations.data.find(item => item.name === 'Setup DSP');
  const request = {
    controlRef: row.controlRef,
    idempotencyKey: 'dashboard:installation:provision:setup',
    expectedRevision: row.installation.revision,
  };
  const missingCsrf = await fetch(`${running.base}/api/platform/installation/provision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: running.cookie },
    body: JSON.stringify(request),
  });
  assert.equal(missingCsrf.status, 403);
  const callerSelectedTarget = await fetch(`${running.base}/api/platform/installation/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify({ ...request, organizationId: 'local-dsp' }),
  });
  assert.equal(callerSelectedTarget.status, 400);
  const callerSubmittedContinuity = await fetch(`${running.base}/api/platform/installation/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify({ ...request, continuityRef: row.continuityRef }),
  });
  assert.equal(callerSubmittedContinuity.status, 400);
  const accepted = await fetch(`${running.base}/api/platform/installation/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify(request),
  });
  const receipt = await accepted.json();
  assert.equal(accepted.status, 202);
  assert.deepEqual(receipt.data, {
    action: 'provision', status: 'accepted', installationState: 'provisioning',
    installationRevision: 2, replayed: false,
  });
  const replay = await (await fetch(`${running.base}/api/platform/installation/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken },
    body: JSON.stringify(request),
  })).json();
  assert.equal(replay.data.status, 'replayed');
  const latest = await (await fetch(`${running.base}/api/platform/organizations`, {
    headers: { Cookie: running.cookie },
  })).json();
  const pending = latest.data.find(item => item.name === 'Setup DSP');
  assert.equal(pending.installation.state, 'provisioning');
  assert.deepEqual(pending.installation.operation, { kind: 'provision', status: 'pending' });
  assert.equal(JSON.stringify(pending).includes('jobId'), false);
  const ownerAfterRequest = await (await fetch(`${running.base}/api/organization/administration`, {
    headers: { Cookie: ownerCookie },
  })).json();
  assert.equal(JSON.stringify(ownerAfterRequest.data.audit).includes('targetId'), false);
  assert.equal(JSON.stringify(ownerAfterRequest.data.audit).includes('organizationId'), false);
});

test('daily API forwards only the closed SDK query and returns sync freshness', async t => {
  const running = await runningServer();
  t.after(running.close);
  const response = await fetch(`${running.base}/api/paycom/daily?date=2026-08-30&search=Fixture&attention=incomplete&limit=10&offset=0`, { headers: { Cookie: running.cookie } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.day.kind, 'workforce_day');
  assert.equal(body.data.day.summary.missingOutDay, 1);
  assert.equal(body.data.sync.data.desiredState, 'running');
  assert.deepEqual(running.client.calls.find(call => call[0] === 'day'), ['day', {
    date: '2026-08-30', search: 'Fixture', attention: 'incomplete', limit: 10, offset: 0,
  }]);

  await fetch(`${running.base}/api/paycom/daily?date=2026-08-30`, { headers: { Cookie: running.cookie } });
  assert.deepEqual(running.client.calls.filter(call => call[0] === 'day').at(-1), ['day', {
    date: '2026-08-30', limit: 100, offset: 0,
  }]);

  const invalid = await fetch(`${running.base}/api/paycom/daily?date=bad`, { headers: { Cookie: running.cookie } });
  assert.equal(invalid.status, 400);
});

test('employee routes require workforce authority, validate closed inputs, and sanitize failures', async t => {
  const client = fixtureClient();
  client.workforce.employees = async query => { client.calls.push(['employees',query]); return { ok: true, status: 'found', data: { items: [], total: 0, hasMore: false } }; };
  client.workforce.employee = async code => { client.calls.push(['employee',code]); return { ok: false, status: 'employee_not_found', error: { code: 'employee_not_found', message: '/private/source' }, data: null }; };
  const running = await runningServer({ client }); t.after(running.close);
  const headers = { Cookie: running.cookie };
  assert.equal((await fetch(`${running.base}/api/paycom/employees`)).status, 401);
  assert.equal((await fetch(`${running.base}/api/paycom/employees`, { headers })).status, 200);
  assert.deepEqual(client.calls.find(c=>c[0]==='employees')[1], { limit: 100, offset: 0, lifecycleStatus: null });
  const response = await fetch(`${running.base}/api/paycom/employees/a001`, { headers });
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /private/);
  assert.deepEqual(client.calls.find(c=>c[0]==='employee'), ['employee','A001']);
  for (const suffix of ['employees?runtime=other','employees?limit=101','employees?offset=1&offset=2','employees/bad','employees/A001?tenant=other','daily?date=2026-02-30','daily?date=2026-08-30&sort=private','daily?date=2026-08-30&direction=random']) {
    assert.equal((await fetch(`${running.base}/api/paycom/${suffix}`, { headers })).status, 400, suffix);
  }
  const before = client.calls.length;
  const ownerRole = running.store.roles('local-dsp').find(role => role.key === 'owner');
  running.store.db.prepare('DELETE FROM role_permissions WHERE role_id=? AND permission=?').run(ownerRole.id, 'workforce.read');
  for (const suffix of ['employees', 'employees/A001', 'daily?date=2026-08-30']) {
    assert.equal((await fetch(`${running.base}/api/paycom/${suffix}`, { headers })).status, 403);
  }
  assert.equal(client.calls.length, before);
});

test('Sync now works without operator mode and requires authentication, tenant permission, and session CSRF', async t => {
  const running = await runningServer({ operator: false });
  t.after(running.close);
  const unauthenticated = await fetch(`${running.base}/api/paycom/sync`, { method: 'POST', body: '{}' });
  assert.equal(unauthenticated.status, 401);
  const forbidden = await fetch(`${running.base}/api/paycom/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: running.cookie }, body: '{}',
  });
  assert.equal(forbidden.status, 403);

  const bootstrap = await (await fetch(`${running.base}/api/bootstrap`, { headers: { Cookie: running.cookie } })).json();
  const queried = await fetch(`${running.base}/api/paycom/sync?runtime=other`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dispatch-CSRF': bootstrap.data.csrfToken, Cookie: running.cookie },
    body: '{}',
  });
  assert.equal(queried.status, 400);
  assert.equal((await queried.json()).status, 'invalid_request');
  assert.equal(running.client.calls.some(item => item[0] === 'sync.runNow'), false);
  const queued = await fetch(`${running.base}/api/paycom/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dispatch-CSRF': bootstrap.data.csrfToken, Cookie: running.cookie },
    body: JSON.stringify({ idempotencyKey: 'dashboard:fixture-sync-request-1' }),
  });
  const receipt = await queued.json();
  assert.equal(queued.status, 202);
  assert.equal(receipt.status, 'queued');
  const call = running.client.calls.find(item => item[0] === 'sync.runNow');
  assert.equal(call[1], 'paycom-main-workforce');
  assert.equal(call[2].idempotencyKey, 'dashboard:fixture-sync-request-1');
  const count = running.client.calls.length;
  const role = running.store.roles('local-dsp').find(item => item.key === 'owner');
  running.store.db.prepare('DELETE FROM role_permissions WHERE role_id=? AND permission=?').run(role.id, 'sync.run');
  const denied = await fetch(`${running.base}/api/paycom/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dispatch-CSRF': bootstrap.data.csrfToken, Cookie: running.cookie },
    body: JSON.stringify({ idempotencyKey: 'dashboard:fixture-sync-request-2' }),
  });
  assert.equal(denied.status, 403);
  assert.equal(running.client.calls.length, count);

});

test('DSP removal requires platform authority and CSRF, queues once and blocks retained invitations', async t => {
  const running = await runningServer({ installationOperator: true });
  t.after(running.close);
  const headers = { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken };
  const create = await (await fetch(`${running.base}/api/platform/organizations`, {
    method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'http:create:removal:alpha',
      name: 'Removal Test DSP', abbreviation: 'REMOVAL', stationCode: 'DWA6',
      timezone: 'America/Chicago', ownerEmail: 'removal@example.test' }),
  })).json();
  const rows = await (await fetch(`${running.base}/api/platform/organizations`, { headers })).json();
  const row = rows.data.find(item => item.name === 'Removal Test DSP');
  const input = { controlRef: row.controlRef, idempotencyKey: 'http:removal:alpha',
    expectedRevision: row.installation.revision };
  const remove = (body, requestHeaders = headers) => fetch(`${running.base}/api/platform/installation/remove`, {
    method: 'POST', headers: requestHeaders, body: JSON.stringify(body),
  });
  assert.equal((await remove(input, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await remove(input, { 'Content-Type': 'application/json', Cookie: running.cookie })).status, 403);
  assert.equal((await remove({ ...input, confirmation: 'wrong' })).status, 400);
  assert.equal((await remove({ ...input, organizationId: 'local-dsp' })).status, 400);
  const response = await remove(input);
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.data.installationState, 'decommissioning');
  assert.equal((await (await remove(input)).json()).data.replayed, true);
  const invitationToken = new URL(create.data.invitationPath, running.base).hash.split('/').at(-1);
  assert.equal((await fetch(`${running.base}/api/auth/invitation/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invitationToken }),
  })).status, 404);
  const latest = await (await fetch(`${running.base}/api/platform/organizations`, { headers })).json();
  const removed = latest.data.find(item => item.name === row.name);
  assert.deepEqual(removed.installation.operation, { kind: 'decommission', status: 'queued' });
  assert.deepEqual(removed.availableActions, []);
  assert.equal(latest.data.find(item => item.name === 'Fixture DSP').installation.state, 'ready');
});


test('owner Paycom HTTP setup requires owner membership, CSRF and a closed body before credential delivery', async t => {
  const calls = [];
  const running = await runningServer({ installationOperator: true, installationBackend: 'oci_container_v1',
    paycomInvoke: async (...args) => { calls.push(args); return { ok: true, status: 'succeeded', data: { configured: true }, error: null }; } });
  t.after(running.close);
  const platform = running.access.session(running.cookie.slice('dispatch_session='.length));
  const dsp = running.access.createOrganization(platform, { idempotencyKey: 'http:paycom:create', name: 'HTTP Paycom DSP',
    abbreviation: 'HTTP', stationCode: 'TST1', timezone: 'UTC', ownerEmail: 'http-dsp@example.test' });
  const owner = await running.access.acceptNewUser({ token: dsp.token, firstName: 'HTTP', lastName: 'Owner',
    password: 'fixture owner password', confirmPassword: 'fixture owner password' });
  running.store.updateInstallationControl({ organizationId: dsp.organization.id, expectedStatus: 'pending', expectedRevision: 1,
    status: 'waiting_for_provider_auth', revision: 2, currentJobId: null, timestamp: Date.now() });
  require('../../core/accounts/tests/plugin-fixture').enableFixturePlugin(running.store, dsp.organization.id);
  const input = { idempotencyKey: 'http:paycom:enroll', intent: 'create', credentials: {
    clientCode: 'fixture', username: 'fixture', password: 'fixture', pin1: '1', pin2: '2', pin3: '3', pin4: '4', pin5: '5',
  } };
  const endpoint = `${running.base}/api/organization/paycom-setup`;
  const headers = { 'Content-Type': 'application/json', Cookie: `dispatch_session=${owner.token}`, 'X-Dispatch-CSRF': owner.session.csrfToken };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Dispatch-CSRF': 'wrong' }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...input, runtimeKey: 'local' }) })).status, 400);
  const invalidCredentials = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...input, credentials: { ...input.credentials, pin5: '1' } }) });
  assert.equal(invalidCredentials.status, 400);
  assert.equal((await invalidCredentials.json()).error.code, 'paycom_credentials_invalid');
  assert.equal(calls.length, 0);
  const result = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(result.status, 202);
  assert.equal((await result.json()).data.status, 'queued');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], running.store.installationControl(dsp.organization.id).runtimeKey);
  const replay = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await replay.json()).data.replayed, true);
  assert.equal(calls.length, 1);
});

test('email-first creation and rollout HTTP routes enforce platform permissions, CSRF and fixed targets', async t => {
  const running = await runningServer({ installationOperator: true, installationBackend: 'oci_container_v1', updates: true });
  t.after(running.close);
  const headers = { 'Content-Type': 'application/json', Cookie: running.cookie, 'X-Dispatch-CSRF': running.csrfToken };
  const createdResponse = await fetch(`${running.base}/api/platform/organizations`, { method: 'POST', headers,
    body: JSON.stringify({ ownerEmail: 'email-first@example.test', idempotencyKey: 'dashboard:email-first:create' }) });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  const row = running.store.organizations().find(o => o.name === 'New DSP');
  assert.equal(running.store.installationControl(row.id).status, 'provisioning');
  assert.equal(running.store.db.prepare('SELECT count(*) n FROM installation_provisioning_requests').get().n, 1);
  const token = new URL(created.invitationPath, running.base).hash.split('/').at(-1);
  const registered = await fetch(`${running.base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, firstName: 'New', lastName: 'Owner', password: 'new owner password', confirmPassword: 'new owner password' }) });
  assert.equal(registered.status, 201);
  const ownerHeaders = { Cookie: registered.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(`${running.base}/api/platform/updates`, { headers: ownerHeaders })).status, 403);
  assert.equal((await fetch(`${running.base}/api/platform/updates`)).status, 401);
  assert.equal((await fetch(`${running.base}/api/organization/profile`, { headers: ownerHeaders })).status, 200);
  assert.equal((await fetch(`${running.base}/api/organization/profile?organizationId=local-dsp`, { headers: ownerHeaders })).status, 400);
  const start = { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'dashboard:rollout:start' };
  assert.equal((await fetch(`${running.base}/api/platform/updates`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: running.cookie }, body: JSON.stringify(start) })).status, 403);
  assert.equal((await fetch(`${running.base}/api/platform/updates`, { method: 'POST', headers, body: JSON.stringify({ ...start, releaseId: 'https://attacker.test/image' }) })).status, 409);
  // A fleet still provisioning cannot enter the shared backup phase.
  assert.equal((await fetch(`${running.base}/api/platform/updates`, { method: 'POST', headers, body: JSON.stringify(start) })).status, 409);
  running.store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(row.id);
  running.store.updateOrganizationStatus(row.id, 'active', Date.now());
  const response = await fetch(`${running.base}/api/platform/updates`, { method: 'POST', headers, body: JSON.stringify(start) });
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.rollout.total, 2);
  assert.equal(data.rollout.status, 'running');
  for (const forbidden of ['runtimeKey', 'organizationId', 'imageDigest', 'socket', 'databaseRoot']) assert.equal(JSON.stringify(data).includes(forbidden), false);
});


test('Core readiness reports the running bundle only when identity and central storage are ready', async t => {
  const legacy = await runningServer(); t.after(legacy.close);
  assert.equal((await fetch(`${legacy.base}/api/platform/core-health`)).status, 503);
  const identity = { releaseId: 'dispatch_update_2', version: '0.0.2', sourceCommit: 'a'.repeat(40) };
  const running = await runningServer({ coreIdentity: identity }); t.after(running.close);
  const ready = await fetch(`${running.base}/api/platform/core-health`);
  assert.equal(ready.status, 200);
  assert.deepEqual((await ready.json()).data, identity);
  running.store.db.exec('ALTER TABLE users RENAME TO unavailable_users');
  assert.equal((await fetch(`${running.base}/api/platform/core-health`)).status, 500);
});


test('Core verification blocks authenticated and public traffic without modifying business or session data', async t => {
  let maintenance = { rolloutId: 'rollout_' + 'a'.repeat(32), nonce: 'b'.repeat(64) };
  const running = await runningServer({ coreIdentity: { releaseId: 'dispatch_update_2', version: '0.0.2', sourceCommit: 'c'.repeat(40) },
    coreMaintenance: () => maintenance });
  t.after(running.close);
  const before = running.store.db.prepare('SELECT * FROM sessions').all();
  for (const endpoint of ['/', '/login', '/api/auth/session', '/api/workforce/day']) {
    const response = await fetch(running.base + endpoint, { headers: { cookie: running.cookie } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '10');
  }
  const post = await fetch(running.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'correct horse battery staple' }) });
  assert.equal(post.status, 503);
  assert.deepEqual(running.store.db.prepare('SELECT * FROM sessions').all(), before);
  const normal = await (await fetch(running.base + '/api/platform/core-health')).json();
  assert.equal(normal.data.recoveryProbe, undefined);
  const probe = await (await fetch(running.base + '/api/platform/core-health', { headers: { 'X-Dispatch-Recovery-Probe': maintenance.nonce } })).json();
  assert.equal(probe.data.recoveryProbe, 'passed');
  assert.equal(running.store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='dispatch_recovery_probe'").get().n, 0);
  maintenance = null;
  assert.equal((await fetch(running.base + '/', { headers: { cookie: running.cookie } })).status, 200);
});

test('invalid maintenance records keep traffic closed and cannot authorize a probe', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-maintenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const { createCoreMaintenance, probeAllowed } = require('../server/core-maintenance');
  const read = createCoreMaintenance(root);
  assert.equal(read(), null);
  fs.writeFileSync(path.join(root, 'config/core-maintenance.json'), '{invalid', { mode: 0o600 });
  assert.deepEqual(read(), { nonce: null });
  assert.equal(probeAllowed(read(), 'b'.repeat(64)), false);
  assert.equal(probeAllowed({ nonce: 'short' }, 'b'.repeat(64)), false);
});


test('backup HTTP routes protect schedules and restore commands with owner authorization, CSRF and strict inputs', async t => {
  const running = await runningServer({installationOperator:true,installationBackend:'oci_container_v1',backups:true});
  t.after(running.close);
  const endpoint = `${running.base}/api/platform/backups`;
  const headers = {'Content-Type':'application/json',Cookie:running.cookie,'X-Dispatch-CSRF':running.csrfToken};
  assert.equal((await fetch(endpoint)).status,401);
  const view=await (await fetch(endpoint,{headers})).json();
  assert.equal(view.data.settings.enabled,false);
  const input={action:'settings',idempotencyKey:'http:backups:settings',revision:view.data.revision,settings:{...view.data.settings,enabled:true,retentionDays:30}};
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,'X-Dispatch-CSRF':'wrong'},body:JSON.stringify(input)})).status,403);
  assert.equal((await fetch(endpoint+'?organizationId=other',{headers})).status,400);
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({...input,path:'/etc/passwd'})})).status,400);
  const saved=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(saved.status,200);
  assert.equal((await saved.json()).data.settings.retentionDays,30);
  const platform=running.access.session(running.cookie.slice('dispatch_session='.length));
  const invitation=running.access.createOrganization(platform,{ownerEmail:'backup-dsp@example.test',idempotencyKey:'http:backup:dsp:create'});
  const owner=await running.access.acceptNewUser({token:invitation.token,firstName:'DSP',lastName:'Owner',password:'synthetic owner password',confirmPassword:'synthetic owner password'});
  assert.equal((await fetch(endpoint,{headers:{Cookie:`dispatch_session=${owner.token}`}})).status,403);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,Cookie:`dispatch_session=${owner.token}`,'X-Dispatch-CSRF':owner.session.csrfToken},body:JSON.stringify(input)})).status,403);
});


test('DSP audit filters platform access before limiting and enforces independent audit permission', async t => {
  const running = await runningServer({ platformOnly: true, installationOperator: true, installationBackend: 'oci_container_v1' });
  t.after(running.close);
  const { access, store, base, cookie } = running;
  const platform = access.session(cookie.split('=')[1]);
  const invitation = access.createOrganization(platform, {
    ownerEmail: 'audit-owner@example.test', idempotencyKey: 'http:audit:dsp:create',
  });
  const owner = await access.acceptNewUser({
    token: invitation.token, firstName: 'Audit', lastName: 'Owner',
    password: 'synthetic audit password', confirmPassword: 'synthetic audit password',
  });
  const organizationId = invitation.organization.id;
  const headers = { Cookie: `dispatch_session=${owner.token}` };
  const endpoint = `${base}/api/organization/audit`;
  const timestamp = access.now() + 1000;
  access.audit({ organizationId, action: 'role.create', targetType: 'role', actorUserId: owner.session.user.id, timestamp });
  access.audit({ organizationId, action: 'installation.upgrade.complete', targetType: 'installation', timestamp });
  // Actual support changes stay attributable; entering a DSP is internal-only.
  access.audit({ organizationId, action: 'role.update', targetType: 'role', actorUserId: platform.user.id, timestamp });
  for (let i = 0; i < 105; i++) {
    access.audit({ organizationId, action: 'organization.view.start', targetType: 'organization', actorUserId: platform.user.id, timestamp: timestamp + i + 1 });
  }
  access.ensureLocalOrganization({ organization: { id: 'other-dsp', name: 'Other DSP' }, site: { code: 'TST1' }, timezone: 'UTC' });
  access.audit({ organizationId: 'other-dsp', action: 'other.tenant.event', targetType: 'organization', timestamp });
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(`${endpoint}?organizationId=other-dsp`, { headers })).status, 400);
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.audit.some(event => event.action.startsWith('organization.view.')), false);
  assert.equal(data.audit.some(event => event.action === 'other.tenant.event'), false);
  assert.equal(data.audit.find(event => event.action === 'role.create').actor, owner.session.user.email);
  assert.equal(data.audit.find(event => event.action === 'installation.upgrade.complete').actor, 'System');
  assert.equal(data.audit.find(event => event.action === 'role.update').actor, platform.user.email);
  assert.ok(data.audit.length <= 100);
  const legacy = await (await fetch(`${base}/api/organization/administration`, { headers })).json();
  assert.deepEqual(legacy.data.audit, data.audit);
  assert.equal(store.audits(organizationId, 200).filter(event => event.action === 'organization.view.start').length, 105);

  const auditRole = store.roleByKey(organizationId, 'driver');
  const memberInvite = access.createMemberInvitation(owner.session, organizationId, {
    email: 'auditor@example.test', roleId: auditRole.id,
  });
  const auditor = await access.acceptNewUser({
    token: memberInvite.token, firstName: 'DSP', lastName: 'Auditor',
    password: 'synthetic auditor password', confirmPassword: 'synthetic auditor password',
  });
  const auditorHeaders = { Cookie: `dispatch_session=${auditor.token}` };
  assert.equal((await fetch(endpoint, { headers: auditorHeaders })).status, 200);
  assert.equal((await fetch(`${base}/api/organization/administration`, { headers: auditorHeaders })).status, 200);
  // Permission checks still consult storage on every request for future role changes.
  store.db.prepare("DELETE FROM role_permissions WHERE role_id=? AND permission='audit.read'").run(auditRole.id);
  assert.equal((await fetch(endpoint, { headers: auditorHeaders })).status, 403);
  store.updateOrganizationStatus(organizationId, 'suspended', access.now());
  assert.equal((await fetch(endpoint, { headers })).status, 401);
});

test('DSP viewing gives a platform owner scoped owner writes with actor attribution and normal CSRF checks', async t => {
  const running = await runningServer({ platformOnly: true, operator: true });
  t.after(running.close);
  const { access, store, base, cookie, csrfToken } = running;
  const org = access.ensureLocalOrganization({ organization: { id: 'local-dsp', name: 'Viewed DSP' }, site: { code: 'TST1' }, timezone: 'UTC' });
  require('../../core/accounts/tests/plugin-fixture').enableFixturePlugin(store, 'local-dsp');
  const platform = access.session(cookie.split('=')[1]);
  const controlRef = access.issuePlatformControlRef(platform, org.id);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': csrfToken };
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers })).status, 409);
  assert.equal((await fetch(`${base}/api/platform/organization/view`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ controlRef }),
  })).status, 403);
  const started = await fetch(`${base}/api/platform/organization/view`, { method: 'POST', headers, body: JSON.stringify({ controlRef }) });
  assert.equal(started.status, 200);
  const viewed = (await started.json()).data;
  assert.equal(viewed.user.id, platform.user.id);
  assert.equal(viewed.dspView.access, 'owner');
  assert.equal(viewed.activeOrganizationId, org.id);
  assert.equal(viewed.memberships[0].roleKey, 'owner');
  assert.equal(store.membership(platform.user.id, org.id), null);
  assert.equal(store.audits(org.id).find(a => a.action === 'organization.view.start').actor, platform.user.email);
  const scoped = { ...headers, 'X-Dispatch-DSP-View': viewed.dspView.viewRef };
  const session = (await (await fetch(`${base}/api/auth/session`, { headers: scoped })).json()).data;
  assert.equal(session.activeOrganizationId, org.id);
  for (const pathname of ['/api/bootstrap', '/api/paycom/daily?date=2026-08-30', '/api/integrations', '/api/organization/administration', '/api/organization/profile']) {
    const result = await fetch(`${base}${pathname}`, { headers: scoped });
    assert.equal(result.status, 200, pathname);
    if (pathname === '/api/organization/administration') assert.equal((await result.json()).data.organization.id, org.id);
  }
  const command = async (pathname, method, body, expected = 200) => {
    const response = await fetch(`${base}${pathname}`, { method, headers: scoped, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, `${pathname}: ${JSON.stringify(result)}`);
    return result.data;
  };
  const roleBody = { name: 'Support role', description: 'Created by platform support', permissions: ['dashboard.view', 'workforce.read'] };
  const missingCsrf = await fetch(`${base}/api/organization/roles`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Dispatch-DSP-View': viewed.dspView.viewRef }, body: JSON.stringify(roleBody) });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, 'csrf_invalid');
  await command('/api/organization/roles', 'POST', roleBody, 409);
  const role = store.roleByKey(org.id, 'dispatcher');
  await command(`/api/organization/roles/${role.id}`, 'PUT', { ...roleBody, name: 'Updated support role' }, 409);
  const invite = await command('/api/organization/invitations', 'POST', { email: 'supported-member@example.test', roleId: role.id }, 201);
  const invitationToken = invite.invitationPath.split('/').at(-1);
  const member = await access.acceptNewUser({ token: invitationToken, firstName: 'Supported', lastName: 'Member', password: 'synthetic member password', confirmPassword: 'synthetic member password' });
  const membership = store.membership(member.session.user.id, org.id);
  const viewer = store.roles(org.id).find(r => r.key === 'driver');
  await command(`/api/organization/members/${membership.id}/role`, 'PUT', { roleId: viewer.id });
  await command(`/api/organization/members/${membership.id}`, 'DELETE', {});
  await command(`/api/organization/roles/${role.id}`, 'DELETE', {}, 409);
  store.createLifecycleJob({ id: 'life_support_backup', organizationId: org.id, operation: 'backup',
    startingState: 'ready', installationState: 'ready', installationRevision: 1, manifestRevision: 1,
    runtimeKey: 'local', releaseId: 'dispatch_current_1', targetReleaseId: null, backupId: null,
    safetyBackupId: null, authorityScope: 'platform', idempotencyKey: 'test:support:backup', stages: [], timestamp: access.now() });
  const locked = await fetch(`${base}/api/paycom/sync`, { method: 'POST', headers: scoped, body: JSON.stringify({ idempotencyKey: 'test:support:sync-request' }) });
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).error.code, 'backup_operation_in_progress');
  store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',finished_at=1,result_json='{}' WHERE id='life_support_backup'").run();
  await command('/api/paycom/sync', 'POST', { idempotencyKey: 'test:support:sync-request' }, 202);
  assert.equal(running.client.calls.filter(call => call[0] === 'sync.runNow').length, 1);
  for (const action of ['membership.role.update', 'membership.remove', 'sync.run.request']) {
    assert.equal(store.audits(org.id).find(a => a.action === action).actor, platform.user.email, action);
  }
  for (const pathname of ['/api/platform/organization/status', '/api/platform/organizations', '/api/platform/updates', '/api/platform/backups', '/api/platform/diagnostics', '/api/auth/select-organization', '/api/auth/register', '/api/auth/login']) {
    const result = await fetch(`${base}${pathname}`, { method: 'POST', headers: scoped, body: '{}' });
    assert.equal(result.status, 403, pathname);
    assert.equal((await result.json()).error.code, 'dsp_view_scope', pathname);
  }
  assert.equal((await fetch(`${base}/api/platform/organizations`, { headers: scoped })).status, 403);
  const internal = access.dspViewSession(platform, viewed.dspView.viewRef);
  assert.throws(() => access.requirePermission(internal, 'other-dsp', 'members.manage'), /organization_forbidden/);
  // Complete actual DSP onboarding through the same owner endpoint.
  store.db.prepare('INSERT INTO organization_profiles(organization_id,owner_email) VALUES(?,?)').run(org.id, 'dsp-owner@example.test');
  store.db.prepare("UPDATE installations SET status='waiting_for_provider_auth' WHERE organization_id=?").run(org.id);
  await command('/api/organization/profile', 'POST', { name: 'Supported DSP', abbreviation: 'SUP', stationCode: 'TST1', timezone: 'UTC' });
  assert.equal(store.organization(org.id).name, 'Supported DSP');
  assert.equal(store.audits(org.id).find(a => a.action === 'organization.details.submit').actor, platform.user.email);
  // A separate tab and exiting view retain the original platform session.
  const original = (await (await fetch(`${base}/api/auth/session`, { headers })).json()).data;
  assert.equal(original.dspView, undefined);
  assert.equal(original.activeOrganizationId, null);
  assert.deepEqual(original.memberships, []);
  assert.equal((await fetch(`${base}/api/platform/organizations`, { headers })).status, 200);
});

test('DSP viewing rejects forged, cross-session, tenant, expired, suspended and removed scopes', async t => {
  const running = await runningServer({ platformOnly: true });
  t.after(running.close);
  const { access, store, base, cookie, csrfToken } = running;
  access.ensureLocalOrganization({ organization: { id: 'local-dsp', name: 'Viewed DSP' }, site: { code: 'TST1' }, timezone: 'UTC' });
  const platform = access.session(cookie.split('=')[1]);
  const ref = access.issuePlatformControlRef(platform, 'local-dsp');
  const viewed = access.beginDspView(platform, { controlRef: ref });
  const request = (viewRef, sessionCookie = cookie) => fetch(`${base}/api/organization/administration`, { headers: { Cookie: sessionCookie, 'X-Dispatch-DSP-View': viewRef } });
  assert.equal((await request(ref)).status, 403); // A platform control is not a viewing capability.
  assert.equal((await request('x'.repeat(43))).status, 403);
  const second = access.createSession(platform.user.id);
  assert.equal((await request(viewed.dspView.viewRef, `dispatch_session=${second.token}`)).status, 403);
  const tenantInvite = access.createOrganization(platform, { idempotencyKey: 'test:dsp-view:tenant', name: 'Tenant DSP', stationCode: 'DOT6', timezone: 'UTC', ownerEmail: 'tenant@example.test' });
  assert.throws(() => access.requirePermission(viewed, tenantInvite.organization.id, 'members.manage'), /organization_forbidden/);
  const foreignRole = store.roles(tenantInvite.organization.id).find(r => r.key === 'driver');
  assert.throws(() => access.updateRole(viewed, 'local-dsp', foreignRole.id, { name: 'Wrong DSP', description: '', permissions: [] }), /role_not_found/);
  const oldView = access.issuePlatformControlRef(platform, 'local-dsp', 'dispatch_dsp_view_v1');
  assert.equal((await request(oldView)).status, 403);
  const tenant = await access.acceptNewUser({ token: tenantInvite.token, firstName: 'Tenant', lastName: 'Owner', password: 'synthetic tenant password', confirmPassword: 'synthetic tenant password' });
  assert.equal((await request(viewed.dspView.viewRef, `dispatch_session=${tenant.token}`)).status, 403);
  const tenantStart = await fetch(`${base}/api/platform/organization/view`, { method: 'POST', headers: { Cookie: `dispatch_session=${tenant.token}`, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': tenant.session.csrfToken }, body: JSON.stringify({ controlRef: ref }) });
  assert.equal(tenantStart.status, 403);
  store.updateOrganizationStatus('local-dsp', 'suspended', access.now());
  assert.equal((await request(viewed.dspView.viewRef)).status, 403);
  assert.throws(() => access.beginDspView(platform, { controlRef: ref }), /dsp_view_unavailable/);
  store.updateOrganizationStatus('local-dsp', 'active', access.now());
  store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id='local-dsp'").run();
  assert.equal((await request(viewed.dspView.viewRef)).status, 403);
  store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id='local-dsp'").run();
  const timestamp = access.now();
  access.clock = () => new Date(timestamp + 16 * 60 * 1000);
  assert.equal((await request(viewed.dspView.viewRef)).status, 403);
  access.clock = () => new Date(timestamp);
  access.signOut(platform);
  assert.equal((await request(viewed.dspView.viewRef)).status, 401);
});


test('Turnstile gates password checks and invitation registration, enforces single-use tokens, and preserves sessions', async t => {
  const { createTurnstile } = require('../server/turnstile');
  const used = new Set();
  const turnstile = createTurnstile({ siteKey: '0x' + 'a'.repeat(24), secret: '0x' + 'b'.repeat(33),
    hostname: 'dispatch.example.test', fetchImpl: async (_url, init) => {
      const { response } = JSON.parse(init.body);
      if (response === 'unavailable') throw Error('provider failure');
      const success = !used.has(response) && response !== 'expired'; used.add(response);
      return { ok: true, json: async () => ({ success, hostname: 'dispatch.example.test', action: response.split(':')[0] }) };
    } });
  const running = await runningServer({ platformOnly: true, installationOperator: true, installationBackend: 'native_service_v1', turnstile });
  t.after(running.close);
  let passwordChecks = 0, registrations = 0;
  const signIn = running.access.signIn.bind(running.access), accept = running.access.acceptNewUser.bind(running.access);
  running.access.signIn = async body => { passwordChecks++; assert.equal(body.turnstileToken, undefined); return signIn(body); };
  running.access.acceptNewUser = async body => { registrations++; assert.equal(body.turnstileToken, undefined); return accept(body); };
  const post = async (route, body) => {
    const response = await fetch(running.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { response, body: await response.json() };
  };
  const login = { email: 'owner@example.test', password: 'correct horse battery staple' };
  for (const [token, code] of [[undefined, 'turnstile_required'], ['expired', 'turnstile_invalid'], ['register:wrong-action', 'turnstile_invalid'], ['unavailable', 'turnstile_unavailable']]) {
    const result = await post('/api/auth/login', { ...login, ...(token ? { turnstileToken: token } : {}) });
    assert.equal(result.body.error.code, code);
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
  assert.equal(passwordChecks, 0);
  const deniedPassword = await post('/api/auth/login', { ...login, password: 'incorrect password', turnstileToken: 'login:1' });
  assert.equal(deniedPassword.body.error.code, 'invalid_credentials');
  assert.equal((await post('/api/auth/login', { ...login, turnstileToken: 'login:1' })).body.error.code, 'turnstile_invalid');
  assert.equal(passwordChecks, 1);
  const success = await post('/api/auth/login', { ...login, turnstileToken: 'login:2' });
  assert.equal(success.response.status, 200);
  assert.match(success.response.headers.get('set-cookie'), /dispatch_session=/);
  const invitation = running.access.createOrganization(running.access.session(running.cookie.split('=')[1]), {
    idempotencyKey: 'turnstile:registration:fixture', ownerEmail: 'new-turnstile@example.test',
  });
  const registration = { token: invitation.token, firstName: 'New', lastName: 'Owner', password: login.password, confirmPassword: login.password };
  for (const token of [undefined, 'login:wrong-action', 'expired', 'unavailable']) {
    const denied = await post('/api/auth/register', { ...registration, ...(token ? { turnstileToken: token } : {}) });
    assert.ok(denied.response.status >= 400);
    assert.equal(denied.response.headers.get('set-cookie'), null);
  }
  assert.equal(registrations, 0);
  assert.equal((await post('/api/auth/register', { ...registration, turnstileToken: 'register:1' })).response.status, 201);
  assert.equal(registrations, 1);
  const session = await fetch(running.base + '/api/auth/session');
  assert.deepEqual((await session.json()).data.turnstile, turnstile.publicConfig);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  const page = await fetch(running.base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' https:\/\/challenges.cloudflare.com/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /'unsafe-inline'|'unsafe-eval'/);
  assert.match(page.headers.get('content-security-policy'), /frame-src https:\/\/challenges.cloudflare.com/);
  const cookie = success.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(running.base + '/api/auth/session', { headers: { Cookie: cookie } })).json()).data.authenticated, true);
});

test('Turnstile rejections use the login attempt limit while provider outages do not lock accounts', async t => {
  const { createTurnstile } = require('../server/turnstile');
  let checks = 0;
  const turnstile = createTurnstile({ siteKey: '0x' + 'a'.repeat(24), secret: '0x' + 'b'.repeat(33),
    hostname: 'dispatch.example.test', fetchImpl: async (_url, init) => {
      checks++;
      if (JSON.parse(init.body).response === 'outage') throw Error('synthetic outage');
      return { ok: true, json: async () => ({ success: false }) };
    } });
  const running = await runningServer({ platformOnly: true, turnstile }); t.after(running.close);
  const attempt = async (email, token) => fetch(running.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'irrelevant password', turnstileToken: token }),
  });
  for (let i = 0; i < 9; i++) assert.equal((await attempt('outage@example.test', 'outage')).status, 503);
  for (let i = 0; i < 8; i++) assert.equal((await attempt('owner@example.test', 'invalid')).status, 403);
  const throttled = await attempt('owner@example.test', 'invalid');
  assert.equal(throttled.status, 429);
  assert.equal((await throttled.json()).error.code, 'login_rate_limited');
  assert.equal(checks, 17);
});

test('collection status uses the authenticated DSP and rejects scope overrides', async t => {
  const running = await runningServer();
  t.after(running.close);
  const endpoint = `${running.base}/api/paycom/sync`;
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { Cookie: running.cookie };
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.data.activity, 'idle');
  assert.equal(value.data.lastSucceededAt, COLLECTED);
  assert.equal((await fetch(`${endpoint}?runtime=another-dsp`, { headers })).status, 400);
});


test('Connections HTTP protects owner mutations, CSRF, DSP selection, and response secrecy', async t => {
  const calls = [];
  const view = service => ({ service, configured: true, state: 'checking', checkedAt: null, reason: null, retryAt: null });
  const running = await runningServer({ installationOperator: true, installationBackend: 'native_service_v1',
    connectionsInvoke: async (...args) => { calls.push(args); return { ok: true, status: args[2].command === 'list' ? 'found' : 'accepted',
      data: args[2].command === 'list' ? { items: ['cortex', 'paycom'].map(view) } : view(args[2].service), error: null }; } });
  t.after(running.close);
  const platform = running.access.session(running.cookie.slice('dispatch_session='.length));
  const dsp = running.access.createOrganization(platform, { idempotencyKey: 'http:connections:create', name: 'Connections DSP',
    abbreviation: 'HTTP', stationCode: 'TST1', timezone: 'UTC', ownerEmail: 'connections-dsp@example.test' });
  const owner = await running.access.acceptNewUser({ token: dsp.token, firstName: 'HTTP', lastName: 'Owner',
    password: 'fixture owner password', confirmPassword: 'fixture owner password' });
  running.store.updateInstallationControl({ organizationId: dsp.organization.id, expectedStatus: 'pending', expectedRevision: 1,
    status: 'ready', revision: 2, currentJobId: null, timestamp: Date.now() });
  require('../../core/accounts/tests/plugin-fixture').enableFixturePlugin(running.store, dsp.organization.id);
  running.store.updateOrganizationStatus(dsp.organization.id, 'active', Date.now());
  const endpoint = `${running.base}/api/organization/connections/cortex/save`;
  const input = { credentials: { username: 'fixture', password: 'private-http-connection' } };
  const headers = { 'Content-Type': 'application/json', Cookie: `dispatch_session=${owner.token}`, 'X-Dispatch-CSRF': owner.session.csrfToken };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Dispatch-CSRF': 'wrong' }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...input, runtimeKey: 'another' }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Cookie: running.cookie }, body: JSON.stringify(input) })).status, 403);
  assert.equal(calls.length, 0);
  const result = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(result.status, 202);
  assert.equal((await result.text()).includes(input.credentials.password), false);
  assert.equal(calls[0][0], running.store.installationControl(dsp.organization.id).runtimeKey);
  const response = await fetch(`${running.base}/api/organization/connections`, { headers });
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.deepEqual(data.services.map(item => item.id), ['cortex', 'paycom']);
  assert.equal(JSON.stringify(data).includes('profile'), false);
  const viewed = running.access.beginDspView(platform, {
    controlRef: running.access.issuePlatformControlRef(platform, dsp.organization.id),
  });
  const scoped = { ...headers, Cookie: running.cookie, 'X-Dispatch-CSRF': platform.csrfToken,
    'X-Dispatch-DSP-View': viewed.dspView.viewRef };
  const platformList = await fetch(`${running.base}/api/organization/connections`, { headers: scoped });
  assert.equal(platformList.status, 200);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...scoped, 'X-Dispatch-CSRF': 'wrong' }, body: JSON.stringify(input) })).status, 403);
  const supported = await fetch(endpoint, { method: 'POST', headers: scoped, body: JSON.stringify(input) });
  assert.equal(supported.status, 202);
  assert.equal((await supported.text()).includes(input.credentials.password), false);
  for (const command of ['test', 'disconnect']) {
    assert.equal((await fetch(`${running.base}/api/organization/connections/cortex/${command}`, {
      method: 'POST', headers: scoped, body: '{}',
    })).status, 202);
  }
  assert.ok(calls.every(call => call[0] === running.store.installationControl(dsp.organization.id).runtimeKey));
});
