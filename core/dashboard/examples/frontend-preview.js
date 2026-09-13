#!/usr/bin/env node
"use strict";
// Explicitly opted-in, isolated UI fixture. No runtime operations or emails.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AccessStore,
  AccessControlService,
} = require("../../core/accounts/src");
const { createDashboardServer } = require("../server/server");
async function main() {
  if (process.env.DISPATCH_FRONTEND_FIXTURE !== "1")
    throw Error("fixture_opt_in_required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-frontend-"));
  fs.chmodSync(root, 0o700);
  const store = new AccessStore({
    databaseRoot: path.join(root, "access"),
    database: path.join(root, "access/control.sqlite3"),
  });
  const access = new AccessControlService(store, {
    installationOperatorEnabled: true,
    installationBackend: "native_service_v1",
  });
  const password = "synthetic preview password";
  const bootstrap = access.createPlatformBootstrap({
    email: "platform@example.test",
  });
  const platform = await access.acceptNewUser({
    token: bootstrap.token,
    firstName: "Platform",
    lastName: "Owner",
    password,
    confirmPassword: password,
  });
  const organizations = [];
  for (const [i, name] of [
    "Northline Logistics",
    "Cedar Delivery",
    "Atlas Routes",
    "Harbor Logistics",
    "Summit Delivery",
    "Westfield Routes",
    "Maple Delivery",
    "River Routes",
  ].entries()) {
    const result = access.createOrganization(platform.session, {
      idempotencyKey: `preview:frontend:dsp:${i}`,
      ownerEmail: i === 0 ? "owner@example.test" : `owner${i}@example.test`,
      name,
      abbreviation: ["NL01", "CD02", "AR03", "HL04", "SD05", "WR06", "MD07", "RR08"][i],
      stationCode: "TST1",
      timezone: "America/Chicago",
    });
    const id = result.organization.id;
    organizations.push({ id, name, status: "ready", canBackup: true });
    store.db
      .prepare(
        "UPDATE installations SET status='ready' WHERE organization_id=?",
      )
      .run(id);
    store.updateOrganizationStatus(id, "active", Date.now());
    // Keep the optional-connection owner independent of password-change tests.
    if (i >= 5) await access.acceptNewUser({ token: result.token, firstName: "Optional", lastName: "Owner", password, confirmPassword: password });
    if (i === 0) {
      const owner = await access.acceptNewUser({
        token: result.token,
        firstName: "Alex",
        lastName: "Morgan",
        password,
        confirmPassword: password,
      });
      store.updateOrganizationStatus(id, "active", Date.now());
      const ownerSession = access.session(owner.token);
      const role =
        store.roles(id).find((r) => r.key === "manager") ||
        store.roles(id).find((r) => r.key !== "owner");
      for (const [j, member] of [
        "Jamie Chen",
        "Taylor Brooks",
        "Jordan Lee",
      ].entries()) {
        const invite = access.createMemberInvitation(ownerSession, id, {
          email: `member${j}@example.test`,
          roleId:
            j === 2
              ? store.roles(id).find((r) => r.key === "driver").id
              : role.id,
        });
        const [firstName, lastName] = member.split(" ");
        await access.acceptNewUser({
          token: invite.token,
          firstName,
          lastName,
          password,
          confirmPassword: password,
        });
      }
    }
  }
  const unavailable = async () => ({
    ok: false,
    status: "installation_not_ready",
    data: null,
    error: { code: "installation_not_ready" },
  });
  const client = {
    workforce: { day: unavailable },
    sync: { status: unavailable, runNow: unavailable },
    system: { status: unavailable },
  };
  if (process.env.DISPATCH_PAYCOM_WORKFORCE_FIXTURE === "1") client.workforce = require("./paycom-workforce-fixture");
  const previewNotes = require("./grouped-changelog.json");
  const previewRelease = { version: "0.0.9", publishedAt: "2026-09-07T00:00:00.000Z", sourceCommit: "a".repeat(40), core: {},
    changelog: previewNotes.changelog.map(({kind,title,description}) => ({kind,title,description})) };
  const updates = require("../../core/accounts/src/platform-updates").createPlatformUpdates({
    store, enabled: true, releases: { "dispatch_0.0.9": {} }, platformReleases: { "dispatch_0.0.9": previewRelease },
    delivery: { view: () => null, notes: id => id === "dispatch_0.0.9" ? previewNotes : null,
      history: () => ({ "dispatch_0.0.8": { version: "0.0.8", publishedAt: "2026-09-06T00:00:00.000Z", sourceCommit: "b".repeat(40),
        changelog: [{kind:"improved",title:"Clearer rollout progress",description:"Follow Core and DSP update progress."}] } }) }
  });
  let releasePopup = null;
  if (process.env.DISPATCH_POPUP_FIXTURE === "1") {
    const { authoring } = require("../../core/installations/src/release-notes");
    const { createReleasePopup } = require("../../core/accounts/src/release-popup");
    const authored = authoring(require("./popup-changelog.json"));
    const release = { schemaVersion: 1, releaseId: "dispatch_0.0.9", version: "0.0.9", sourceCommit: "a".repeat(40), ...authored.popup };
    store.db.prepare("INSERT INTO platform_rollouts VALUES(?,?,?,?,'completed',?,?)")
      .run("popup_fixture", release.releaseId, platform.session.user.id, "popup_fixture", Date.now(), Date.now());
    store.db.prepare("INSERT INTO platform_rollout_core VALUES(?,'succeeded',?,1,NULL,?)")
      .run("popup_fixture", JSON.stringify({ ...previewRelease, changelog: authored.changelog }), Date.now());
    store.db.prepare("UPDATE installations SET release_id=?").run(release.releaseId);
    releasePopup = createReleasePopup({ store, release });
  }
  const now = new Date().toISOString();
  const backupData = {
    enabled: true,
    canBackupCore: true,
    operationBlocked: null,
    revision: 1,
    nextBackupAt: null,
    settings: {
      enabled: false,
      frequency: "daily",

      time: "02:00",
      weekday: 0,
      timezone: "America/Chicago",
      retentionDays: 30,
    },
    storage: { status: "connected", checkedAt: now },
    organizations,
    operations: [],
    backups: organizations
      .filter((_, i) => i !== 4)
      .map((o, i) => ({
        id: `fixture_backup_${i}`,
        organizationId: o.id,
        kind: "dsp",
        name: o.name,
        createdAt: now,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        retentionDays: 30,
        size: 20 * 1024 * 1024,
        status: "verified",
        verifiedAt: now,
        trigger: "scheduled",
        restoreBlocked: null,
      })),
  };
  backupData.schedules=['system','core',...organizations.map(o=>o.id)].map(scope=>({scope,revision:1,settings:{...backupData.settings},nextBackupAt:null}));
  backupData.sets=[];backupData.deletions=[];
  backupData.backups.push({id:'fixture_core_backup',organizationId:null,kind:'core',name:'Platform Core',createdAt:now,expiresAt:null,retentionDays:null,size:1024,status:'verified',verifiedAt:now,trigger:'manual',restoreBlocked:null});
  const usageScopes=[{scope:'core',name:'Platform Core',removed:false,bytes:8*1048576,backupCount:1},...organizations.map((o,i)=>({scope:o.id,name:o.name,removed:false,bytes:i===4?0:20*1048576,backupCount:i===4?0:1})),{scope:'org_removed_fixture',name:'Pine Delivery',removed:true,bytes:5*1048576,backupCount:2}];
  backupData.storageUsage={status:'ready',checkedAt:now,bytes:usageScopes.reduce((n,s)=>n+s.bytes,0),backupCount:usageScopes.reduce((n,s)=>n+s.backupCount,0),retainedBytes:5*1048576,scopes:usageScopes,sets:[],manifestBytes:0,legacyBytes:0,other:{bytes:0,backupCount:0}};
  const backups = {
    view: () => backupData,
    command: (_session, input) => {
      if (input.action === "settings") {
        const policy=backupData.schedules.find(s=>s.scope===(input.organizationId||input.scope||'system'));policy.settings=input.settings;policy.revision++;
        if(policy.scope==='system'){backupData.settings=input.settings;backupData.revision=policy.revision;}
        return;
      }
      if(input.action==='delete'){backupData.deletions.unshift({id:'fixture_delete',backupId:input.backupId,status:'queued'});return;}
      const ids =
        input.scope==='system' ? [null,...organizations.map(o=>o.id)] : input.scope === "core"
          ? [null]
          : input.organizationIds || [input.organizationId];
      for (const id of ids)
        backupData.operations.unshift({
          id: `fixture_operation_${backupData.operations.length}`,
          organizationId: id,
          kind: input.action === "restore" ? "restore" : id ? "backup" : "core",
          status: "queued",
          phase: "queued",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          backupId: input.backupId || null,
        });
    },
  };
  const runtimePlugins = new Map();
  // Core-only UI checks need catalog metadata but do not install a DSP fixture.
  // Plugin browser checks use the explicitly installed DSP test package.
  let paycomFixtureRoot = null;
  try { paycomFixtureRoot = path.dirname(require.resolve('dispatch-dsp/plugins/paycom/dispatch-plugin.json')); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const paycomManifest = paycomFixtureRoot ? require(path.join(paycomFixtureRoot, 'dispatch-plugin.json'))
    : require('../../tests/fixtures/paycom-plugin.json');
  require('../../shared/plugin-sdk/catalog').configureCatalog(() => [paycomManifest]);
  require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(() => [paycomManifest]);
  const settingsDefinition=paycomManifest.settings;
  const settingsFor=id=>require('../../core/plugins/settings-store').settingsStore(path.join(root,id),'paycom');
  const published=path.join(root,'published/paycom.sqlite3');
  if(process.env.DISPATCH_PAYCOM_WORKFORCE_FIXTURE==='1'){
    const db=require('../../shared/published/database').openDatabase(published,{write:true,journalMode:'DELETE'});
    const adapter=require('dispatch-dsp/plugins/paycom/backend/adapters/published.js');adapter.schema(db);
    adapter.publishPeriod(db,require('./paycom-workforce-fixture').fixtureData,'America/Chicago');db.close();
  }
  for (const [index, organization] of organizations.entries()) {
    const installation = store.installation(organization.id);
    settingsFor(installation.runtimeKey).initialize(settingsDefinition);
    settingsFor(installation.runtimeKey).applied(0);
    const installed = index < 5;
    runtimePlugins.set(installation.runtimeKey, { id: 'paycom', version: paycomManifest.version, state: installed ? 'enabled' : 'uninstalled', revision: installed ? 1 : 0 });
    if (installed) store.db.prepare(`INSERT INTO dsp_plugins(organization_id,plugin_id,version,desired_state,applied_state,
      revision,applied_revision,failure_code,actor_user_id,updated_at) VALUES(?,'paycom',?,'enabled','enabled',1,1,NULL,NULL,?)`)
      .run(organization.id, paycomManifest.version, Date.now());
    store.db.prepare('INSERT INTO plugin_migration_checks(organization_id) VALUES(?)').run(organization.id);
  }
  const plugins = require('../../core/accounts/src/plugins').createPluginService({
    settingsPort:async(id,_plugin,request)=>{
      const storage=settingsFor(id);
      if(request.action==='history')return storage.history(settingsDefinition,request.input);
      if(request.action==='options')return new (require('dispatch-dsp/plugins/paycom/dashboard/published.js').PublishedWorkforcePort)(published).settingsOptions();
      if(request.action==='update'){const saved=storage.update(settingsDefinition,request.input,request.actor);storage.applied(saved.revision);}
      return storage.read(settingsDefinition);
    },
    store, access, backends: ['native_service_v1'], invoke: async (runtimeKey, action, input) => {
      if (action !== 'plugins.manage') throw new Error('unexpected_fixture_action');
      const current = runtimePlugins.get(runtimeKey);
      if (input.command === 'status') return { ok: true, status: 'found', data: { items: [current] }, error: null };
      if (input.revision < current.revision) throw new Error('stale_fixture_revision');
      const next = { id: input.pluginId, version: input.version, state: input.state, revision: input.revision };
      runtimePlugins.set(runtimeKey, next);
      return { ok: true, status: 'applied', data: next, error: null };
    },
  });
  const pluginTimer = setInterval(() => { plugins.runPending().catch(() => {}); }, 100);
  const connectionStates = new Map();
  const emailVerificationFixtures = new Set();
  const connectionInvoke = async (runtimeKey, _action, input) => {
    if (!connectionStates.has(runtimeKey)) connectionStates.set(runtimeKey, new Map(['cortex', 'paycom'].map(service => [service,
      { service, configured: false, state: 'not_connected', checkedAt: null, reason: null, retryAt: null }])));
    const items = connectionStates.get(runtimeKey);
    if (input.command === 'list') return { ok: true, status: 'found', data: { items: [...items.values()] }, error: null };
    if (input.service === 'cortex' && input.command === 'save') {
      if (input.credentials.username === 'verification-fixture') emailVerificationFixtures.add(runtimeKey);
      else emailVerificationFixtures.delete(runtimeKey);
    }
    const previous = items.get(input.service);
    if (input.command === 'verify' && previous?.verification?.id !== input.verificationId)
      return { ok: false, status: 'verification_expired' };
    const view = { service: input.service, configured: input.command !== 'disconnect',
      state: input.command === 'disconnect' ? 'not_connected' : 'checking', checkedAt: null, reason: null, retryAt: null };
    items.set(input.service, view);
    if (view.configured) setTimeout(() => {
      if (items.get(input.service) !== view) return;
      if (input.service === 'cortex' && emailVerificationFixtures.has(runtimeKey)
          && (input.command !== 'verify' || input.code !== '123456')) {
        items.set(input.service, { ...view, state: 'verification_required',
          reason: input.command === 'verify' ? 'verification_code_rejected' : 'mfa_required',
          verification: previous?.verification ? { ...previous.verification, attemptsRemaining: previous.verification.attemptsRemaining - 1 }
            : { id: require('node:crypto').randomBytes(16).toString('base64url'), expiresAt: new Date(Date.now() + 600000).toISOString(), attemptsRemaining: 3 } });
      } else items.set(input.service, { ...view, state: 'connected', checkedAt: new Date().toISOString() });
    }, 800).unref();
    return { ok: true, status: 'accepted', data: { ...view }, error: null };
  };
  const connections = require('../../core/accounts/src/owner-connections').createOwnerConnections({ store, access, invoke: connectionInvoke });
  const paycomSetup = require('../../core/accounts/src/owner-paycom-setup').createOwnerPaycomSetup({ store, access, invoke: unavailable });
  // Deterministic browser-test verifier. This entry point always requires the
  // isolated fixture opt-in above; production main never imports it.
  const usedTurnstileTokens = new Set();
  const turnstile = process.env.DISPATCH_TURNSTILE_FIXTURE === "1" ? require('../server/turnstile').createTurnstile({
    siteKey: '0x' + 'a'.repeat(24), secret: '0x' + 'b'.repeat(33), hostname: '127.0.0.1',
    fetchImpl: async (_url, init) => {
      const { response } = JSON.parse(init.body);
      if (response === 'fixture-unavailable') throw Error('synthetic outage');
      const [prefix, action] = response.split(':');
      const success = prefix === 'fixture' && ['login', 'register', 'forgot_password'].includes(action) && !usedTurnstileTokens.has(response);
      usedTurnstileTokens.add(response);
      return { ok: true, json: async () => ({ success, hostname: '127.0.0.1', action }) };
    },
  }) : null;
  // Synthetic inbox over the test child's private IPC channel; no real mail,
  // HTTP debug endpoint, or token logging. Production never loads this fixture.
  const invitationDelivery = process.env.DISPATCH_RECOVERY_FIXTURE === "1" ? {
    send: async () => ({ status: 'accepted' }),
    sendPasswordReset: async message => { process.send?.({ type: 'password-reset', message }); return { status: 'accepted' }; },
    sendPasswordResetConfirmation: async message => { process.send?.({ type: 'password-reset-confirmation', message }); return { status: 'accepted' }; },
  } : null;
  const server = createDashboardServer({ client, access, updates, backups, paycomSetup, connections, plugins, releasePopup, turnstile, invitationDelivery,
    pluginAssets: async ({ pluginId, revision }) => {
      if (pluginId !== 'paycom') throw new Error('plugin_unavailable');
      if (!paycomFixtureRoot) throw new Error('dsp_test_fixture_required');
      const directory = path.join(root, 'frontend', pluginId);
      if (!fs.existsSync(path.join(directory, 'index.js'))) {
        const { buildFrontend } = await import('../../tooling/build-plugin-frontend.mjs');
        await buildFrontend({ pluginRoot: paycomFixtureRoot,
          output: directory, toolsRoot: path.resolve(__dirname, '..') });
      }
      return { id: pluginId, version: paycomManifest.version, revision, javascript: fs.readFileSync(path.join(directory, 'index.js'), 'utf8'), stylesheet: fs.readFileSync(path.join(directory, 'styles.css'), 'utf8') };
    },
    runtimeResolver: process.env.DISPATCH_PAYCOM_WORKFORCE_FIXTURE === "1" ? installation => ({...client,
      workforce:new (require('../../shared/contracts/src/workforce-client').WorkforceClient)({port:new (require('dispatch-dsp/plugins/paycom/dashboard/published.js').PublishedWorkforcePort)(published,settingsFor(installation.runtimeKey).read(settingsDefinition).values)})}) : null });
  const cleanup = () =>
    server.close(async () => {
      clearInterval(pluginTimer);
      await plugins.runPending();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
      process.exit(0);
    });
  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  const port = Number(process.env.DISPATCH_FRONTEND_PORT || 4339);
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535) throw Error("invalid_preview_port");
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  process.stdout.write(`Synthetic frontend preview: http://127.0.0.1:${server.address().port}\n`);
}
main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
