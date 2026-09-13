#!/usr/bin/env node
'use strict';
// Explicit synthetic fixture. The real API, command queue and release coordinator
// run here; host services and GitHub publication are simulated in private temp data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { AccessStore, AccessControlService } = require('../../core/accounts/src');
const { LocalReleases } = require('../../core/updates/local-releases');
const { UpdateCommands } = require('../../core/updates/commands');
const { UpdateWorker } = require('../../core/updates/worker');
const { createUpdatesService } = require('../../core/updates/service');
const { hash, inventory } = require('../../shared/releases/package');
const { createDashboardServer } = require('../server/server');
async function createPreview({ port = 0, automatic = true, versionedDashboards = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-independent-updates-'));
  const store = new AccessStore({ databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/control.sqlite3') });
  const access = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: 'directory_service_v1' });
  const bootstrap = access.createPlatformBootstrap({ email: 'platform@example.test' }), password = 'synthetic preview password';
  const owner = await access.acceptNewUser({ token: bootstrap.token, firstName: 'Platform', lastName: 'Owner', password, confirmPassword: password });
  const dsps = [], owners = [];
  for (const [index, name] of ['Dev DSP', 'Northline Logistics', 'Cedar Delivery'].entries()) {
    const invitation = access.createOrganization(owner.session, { idempotencyKey: `preview:updates:dsp:${index}`,
      ownerEmail: `owner${index}@example.test`, name, stationCode: 'TST1', timezone: 'UTC' });
    store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(invitation.organization.id);
    store.updateOrganizationStatus(invitation.organization.id, 'active', Date.now());
    owners.push(await access.acceptNewUser({ token: invitation.token, firstName: 'DSP', lastName: 'Owner', password, confirmPassword: password }));
    dsps.push(store.installationControl(invitation.organization.id).runtimeKey);
  }
  let failNext = false, events = [];
  const hooks = { drain: async c => { events.push(['drain', c.product, c.dspId]); },
    snapshot: async () => ({ synthetic: true }), start: async c => {
      if(versionedDashboards && c.product==='dsp')require('../../core/installations/src/release-delivery-files').atomic(require('../../host/releases/runtime').fileFor({local:path.join(root,'local')},c.dspId),{schemaVersion:1,digest:c.digest});
    }, restore: async c => { events.push(['restore', c.dspId]); },
    verify: async c => { if (failNext && c.dspId === [...dsps.slice(1)].sort()[0]) { failNext = false; return false; } return true; } };
  const releases = new LocalReleases({ directory: path.join(root, 'local/state/updates'), devDspId: dsps[0], hooks, allowDevelopment: true });
  async function publish(product, version) {
    const directory = path.join(root, `${product}-${version}`); fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(path.join(directory, 'code')); fs.writeFileSync(path.join(directory, 'code/version.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(directory, 'release-notes.md'), product === 'core'
      ? 'Independent platform updates\n\n• Manage Core releases separately from DSP releases.\n• See installation progress and recover interrupted updates.\n• Keep installed DSP runtimes and plugins unchanged.'
      : 'A better Paycom experience\n\n• Keep each DSP’s settings and credentials independent.\n• Display employee names as First Last by default.\n• Test plugin improvements on Dev before updating your fleet.');
    if(versionedDashboards && product==='dsp'){
      fs.cpSync(path.resolve(__dirname,'../../../dsp/dashboard/public'),path.join(directory,'dashboard'),{recursive:true});
      if(version!=='0.0.1'){
        const file=path.join(directory,'dashboard/assets/frontend.js');
        fs.writeFileSync(file,fs.readFileSync(file,'utf8').replaceAll('Currently under development','Dev release preview'));
      }
    }
    const manifest = { schemaVersion: 1, product, version, channel: 'development', protocol: 1, minimumProtocol: 1,
      sourceDigest: 'a'.repeat(64), plugins: [], files: inventory(directory) };
    fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(manifest));
    const digest = hash(JSON.stringify(manifest)); await releases.stage(directory, digest);
    const state=releases.state();
    if(state.latest.core && state.latest.dsp){
      const entry={version,components:{core:{digest:state.latest.core},dsp:{digest:state.latest.dsp}},
        changes:{core:product==='core' ? 'Platform Owner dashboard and service improvements.' : 'No changes.',dsp:'DSP dashboard and runtime improvements.',plugins:'Paycom connection improvements.'},url:'https://example.test/releases/'+version};
      const history=(state.platform?.history||[]).filter(row=>row.version!==version);history.push(entry);
      state.platform={latest:version,history};releases.save(state);
    }
    return digest;
  }
  const core = await publish('core', '0.0.1'), dsp = await publish('dsp', '0.0.1');
  const state = releases.state(); state.active = { core, dsps: Object.fromEntries(dsps.map(id => [id, dsp])) }; releases.save(state);
  if(versionedDashboards){
    const {privateDirectory}=require('../../host/controller/operations'),{atomic}=require('../../core/installations/src/release-delivery-files');
    for(const id of dsps){const file=require('../../host/releases/runtime').fileFor({local:path.join(root,'local')},id);privateDirectory(path.dirname(file));atomic(file,{schemaVersion:1,digest:dsp});}
  }
  await publish('core', '0.0.2'); await publish('dsp', '0.0.2');
  const commands = new UpdateCommands(path.join(root, 'local/state/updates'));
  const worker = new UpdateWorker({ releases, commands, feed: { refresh: async product => releases.state().latest[product] },
    authorize: actor => { const row = store.userById(actor); if (row?.platform_role !== 'owner' || row.status !== 'active') throw new Error('release_actor_forbidden'); },
    invoke: async (action, input) => {
      if (action === 'update_dev') await releases.updateDev(input.digest);
      else if (action === 'rollout') await releases.beginRollout(input.digest, input.targets, input.actor);
      else if (action === 'step') await releases.step();
      else if (action === 'pause') await releases.pause();
      else if (action === 'resume') await releases.resume();
      else if (action === 'recover') await releases.recover();
      else throw new Error('release_command_invalid');
    } });
  await worker.initialize();
  const updates = createUpdatesService({ releases, commands, store, devDspId: dsps[0] });
  const unavailable = async () => ({ ok: false, status: 'installation_not_ready', data: null, error: { code: 'installation_not_ready' } });
  const server = createDashboardServer({ access, updates, ...(versionedDashboards ? {dashboards:require('../../core/updates/dashboard').dashboardProvider({paths:{local:path.join(root,'local')},store})} : {}), plugins: { catalog: () => ({ items: [] }) },
    client: { workforce: { day: unavailable }, sync: { status: unavailable, runNow: unavailable }, system: { status: unavailable } } });
  const original = server.listeners('request')[0]; server.removeAllListeners('request');
  server.on('request', async (request, response) => {
    if (request.method === 'POST' && ['/__fixture/publish', '/__fixture/fail'].includes(request.url)) {
      if (request.url.endsWith('/publish')) await publish('dsp', '0.0.3'); else failNext = true;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return;
    }
    original(request, response);
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const timer = automatic && setInterval(() => { commands.heartbeat(); worker.tick().catch(() => {}); }, 150);
  return { root, store, access, owner, owners, dsps, releases, commands, worker, events, publish, server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { clearInterval(timer); await worker.close(); await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
if (require.main === module) {
  if (process.env.DISPATCH_INDEPENDENT_UPDATES_FIXTURE !== '1') throw new Error('fixture_opt_in_required');
  createPreview({ port: Number(process.env.DISPATCH_UPDATES_PREVIEW_PORT || 0), versionedDashboards:process.env.DISPATCH_VERSIONED_DASHBOARD_FIXTURE==='1' }).then(app => {
    const close = () => app.close().catch(() => { process.exitCode = 1; });
    process.once('SIGTERM', close); process.once('SIGINT', close);
    process.stdout.write(`Synthetic updates preview: ${app.url}\n`);
  }).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
module.exports = { createPreview };
