'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccessStore, AccessControlService } = require('../src');
const { createPluginService } = require('../src/plugins');
const { success } = require('../../../shared/contracts/src/result');
async function fixture(t, { installationCoordinator = null, settingsPort = null, dspCount = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plugins-'));
  fs.chmodSync(root, 0o700);
  const paths = { databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/access.sqlite3') };
  const store = new AccessStore(paths);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const access = new AccessControlService(store, { installationBackend: 'directory_service_v1', installationOperatorEnabled: true });
  const password = 'synthetic plugin password';
  const bootstrap = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const platform = await access.acceptNewUser({ token: bootstrap.token, firstName: 'Platform', lastName: 'Owner', password, confirmPassword: password });
  const dsps = [];
  const runtimes = new Map();
  for (let index = 0; index < dspCount; index++) {
    const created = access.createOrganization(platform.session, { idempotencyKey: `fixture:plugin:${index}`, name: `Plugin DSP ${index}`,
      abbreviation: `FX${index}`, stationCode: 'TST1', timezone: 'America/Chicago', ownerEmail: `owner${index}@example.test` });
    const owner = await access.acceptNewUser({ token: created.token, firstName: 'DSP', lastName: 'Owner', password, confirmPassword: password });
    const id = created.organization.id;
    store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(id);
    store.updateOrganizationStatus(id, 'active', Date.now());
    const runtimeKey = store.installation(id).runtimeKey;
    dsps.push({ id, runtimeKey, owner: access.session(owner.token), token: owner.token });
    runtimes.set(runtimeKey, { id: 'paycom', version: '0.18.7', state: 'uninstalled', revision: 0 });
  }
  const calls = [];
  let unavailable = false;
  const plugins = createPluginService({ store, access, installationCoordinator: installationCoordinator ? { latest: () => ({version:'0.18.7'}), ...installationCoordinator } : null, settingsPort, invoke: async (runtimeKey, action, input) => {
    calls.push({ runtimeKey, action, input });
    if (unavailable) throw new Error('synthetic runtime unavailable');
    if (input.command === 'status') return success('found', { items: [runtimes.get(runtimeKey)] });
    const current = runtimes.get(runtimeKey);
    if (input.revision < current.revision) throw new Error('stale revision');
    const next = { id: input.pluginId, version: input.version, state: input.state, revision: input.revision };
    runtimes.set(runtimeKey, next);
    return success('applied', next);
  } });
  return { root, paths, store, access, platform, dsps, runtimes, calls, plugins, setUnavailable(value) { unavailable = value; } };
}
function enableFixturePlugin(store, organizationId) {
  store.db.prepare(`INSERT OR REPLACE INTO dsp_plugins(organization_id,plugin_id,version,desired_state,applied_state,
    revision,applied_revision,failure_code,actor_user_id,updated_at) VALUES(?,'paycom','0.18.7','enabled','enabled',1,1,NULL,NULL,?)`)
    .run(organizationId, Date.now());
}
module.exports = { fixture, enableFixturePlugin };
