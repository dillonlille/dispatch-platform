'use strict';
// Destructive disposable-VM drill. Refuses the development/production host.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, "../../../..");
const recovery = require('../../src/host-recovery-bundle');
const { AccessStore, AccessControlService } = require('../../../accounts/src');
const { MANAGED_INSTALLATION_DIRECTORY_FIELDS } = require('../../../../shared/paths/runtime-paths');
const { createOciFixtureDeploymentPlan, renderOciSystemUnit, renderOciBridgeSystemUnit, hostAccountName } = require('../../src/oci-deployment');
const call = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const localRoot = '/home/dispatchfixture/local', uid = 1001, unitRoot = '/home/dispatchfixture/.config/systemd/user';
const config = { coreUid: uid, localRoot }, selected = { scope: 'user', account: { name: 'dispatchfixture', uid } };
const userctl = args => recovery.systemctl(selected, args);
const releaseId = 'dispatch_native_fixture', coreRoot = `/opt/dispatch-platform/releases/${releaseId}/core-artifact`;
const runtimeRoot = `/opt/dispatch-runtime/releases/${releaseId}`;
async function main() {
  if (process.geteuid() !== 0 || os.hostname() !== 'dispatch-recovery-test' || root !== '/work'
      || fs.existsSync('/etc/dispatch') || fs.existsSync(coreRoot)) throw Error('disposable_vm_required');
  call('/usr/sbin/groupadd', ['--gid', String(uid), 'dispatchfixture']);
  call('/usr/sbin/useradd', ['--uid', String(uid), '--gid', String(uid), '--create-home', 'dispatchfixture']);
  for (const child of ['data', 'state', 'config', 'secrets', 'run', 'installations']) fs.mkdirSync(path.join(localRoot, child), { recursive: true, mode: 0o700 });
  fs.mkdirSync(unitRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(coreRoot, { recursive: true });
  fs.cpSync(root, path.join(coreRoot, 'code'), { recursive: true });
  const immutable = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) immutable(file);
      else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o555 : 0o444);
    }
    fs.chmodSync(directory, 0o555);
  };
  immutable(path.join(coreRoot, 'code'));
  const deployment = { releaseId, version: 'fixture', sourceCommit: 'a'.repeat(40), localRoot, unitRoot,
    port: 4310, publicOrigin: 'https://dispatch.example.test' };
  require('../../src/core-artifact-layout').finishCoreArtifact(coreRoot, deployment);
  fs.copyFileSync(path.join(coreRoot, 'units/dispatch-dashboard.service'), path.join(unitRoot, 'dispatch-dashboard.service'));
  fs.chmodSync(path.join(unitRoot, 'dispatch-dashboard.service'), 0o600);
  fs.writeFileSync(path.join(localRoot, 'config/provisioning.env'), `DISPATCH_INSTALLATIONS_ROOT=${localRoot}/installations\nDISPATCH_RUNTIME_AGENT_CONTROL_SOCKET=${localRoot}/run/runtime-agent-control.sock\n`, { mode: 0o600 });
  fs.mkdirSync('/etc/dispatch', { mode: 0o755 });
  fs.writeFileSync('/etc/dispatch/fixture-secret', 'synthetic host secret', { mode: 0o600 });
  fs.writeFileSync(path.join(localRoot, 'secrets/fixture-secret'), 'synthetic core secret', { mode: 0o600 });
  const release = JSON.parse(fs.readFileSync('/root/package/descriptor.json'));
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const nativeArtifact = require('../../src/native-runtime-artifact');
  if (fs.existsSync(path.join(runtimeRoot, 'runtime-artifact'))) nativeArtifact.verifyNativeRuntime(path.join(runtimeRoot, 'runtime-artifact'), release);
  else nativeArtifact.unpackNativeRuntime('/root/package/runtime.tar.gz', path.join(runtimeRoot, 'runtime-artifact'), release);
  if (!fs.existsSync(path.join(runtimeRoot, 'bridge-artifact'))) require('../../src/create-bridge-artifact').main([path.join(runtimeRoot, 'bridge-artifact')]);
  require('../../src/release-delivery-install').installBrowserSandboxProfile();
  const store = new AccessStore({ databaseRoot: path.join(localRoot, 'data/access-control'), database: path.join(localRoot, 'data/access-control/access-control.sqlite3') });
  const access = new AccessControlService(store);
  const invitation = access.createPlatformBootstrap({ email: 'recovery@example.test' });
  const owner = await access.acceptNewUser({ token: invitation.token, firstName: 'Recovery', lastName: 'Fixture',
    password: 'disposable recovery fixture password', confirmPassword: 'disposable recovery fixture password' });
  for (const directory of ['/var/lib/dispatch', '/var/lib/dispatch/tenants']) { fs.mkdirSync(directory, { recursive: true, mode: 0o755 }); fs.chmodSync(directory, 0o755); }
  const plans = [];
  for (let i = 0; i < 2; i++) {
    const id = `org_recovery_${i}`, key = `runtime_recovery_${i}`, accountUid = 20501 + i, name = hostAccountName(key);
    const manifest = { manifestVersion: 1, revision: 1, organization: { id, stationCode: 'DXX1', timezone: 'UTC' },
      runtime: { key, templateId: 'isolated_dsp_v1', releaseId } };
    const authority = { revision: 1, organization: manifest.organization, runtime: manifest.runtime };
    const plan = createOciFixtureDeploymentPlan(manifest, authority, release,
      { name, uid: accountUid, gid: accountUid, subuidStart: 300000 + i * 65536, subgidStart: 300000 + i * 65536, subidCount: 65536 },
      { version: 1, backend: 'native_service_v1', channel: 'fixture', organizationId: id, runtimeKey: key, manifestRevision: 1, releaseId });
    plans.push(plan);
    call('/usr/sbin/groupadd', ['--gid', String(accountUid), name]);
    call('/usr/sbin/useradd', ['--uid', String(accountUid), '--gid', String(accountUid), '--no-create-home', '--home-dir', plan.host.accountHome, name]);
    for (const directory of [plan.host.accountHome, plan.host.installationRoot, ...Object.values(MANAGED_INSTALLATION_DIRECTORY_FIELDS).map(p => path.join(plan.host.installationRoot, p))]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(plan.host.bridgeRoot, { recursive: true, mode: 0o711 }); fs.chmodSync(plan.host.bridgeRoot, 0o711);
    const token = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(path.join(plan.host.installationRoot, 'secrets/runtime-agent/registration-token'), token + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(plan.host.installationRoot, 'data/fixture-record'), `DSP ${i} private records`, { mode: 0o600 });
    call('/usr/bin/chown', ['-R', `${accountUid}:${accountUid}`, plan.host.tenantRoot]);
    store.createOrganization({ id, name: `Recovery DSP ${i}`, abbreviation: null, timezone: 'UTC', status: i ? 'suspended' : 'setup_required', createdBy: null, timestamp: Date.now() });
    store.insertStation(id, 'DXX1', true, Date.now());
    store.createInstallation(id, key, i ? 'suspended' : 'waiting_for_provider_auth', Date.now(), releaseId, 'native_service_v1');
    store.recordRuntimeAgentAuthority({ organizationId: id, runtimeKey: key, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), timestamp: Date.now() });
    fs.writeFileSync(plan.host.unitPath, renderOciSystemUnit(plan));
    fs.writeFileSync(plan.host.bridgeUnitPath, renderOciBridgeSystemUnit(plan, { bridgeExecutable: path.join(runtimeRoot, 'bridge-artifact/core/agent-bridge/src/service-cli.js'),
      centralSocket: path.join(localRoot, 'run/runtime-agent-hub.sock'), centralUid: uid, controllerUid: 0 }));
  }
  store.close();
  call('/usr/bin/chown', ['-R', `${uid}:${uid}`, '/home/dispatchfixture']);
  call('/usr/bin/loginctl', ['enable-linger', 'dispatchfixture']);
  call('/usr/bin/systemctl', ['start', `user@${uid}.service`]); userctl(['daemon-reload']); userctl(['enable', '--now', 'dispatch-dashboard.service']);
  call('/usr/bin/systemctl', ['daemon-reload']);
  call('/usr/bin/systemctl', ['enable', '--now', plans[0].identity.bridgeUnitName, plans[0].identity.unitName]);
  // Deliberately enabled but stopped: restore must also correct this old suspension state.
  call('/usr/bin/systemctl', ['enable', plans[1].identity.bridgeUnitName, plans[1].identity.unitName]);
  const health = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const script = `require('/work/core/agents/src/control').runtimeAgentControlInvoke('${localRoot}/run/runtime-agent-control.sock','${plans[0].runtimeKey}','health',{}).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)`;
        call('/usr/sbin/runuser', ['--user', 'dispatchfixture', '--', '/usr/bin/node', '--no-warnings', '-e', script]); return;
      } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    throw Error('runtime_not_healthy');
  };
  await health();
  const directory = '/root/full-recovery';
  const proof = recovery.captureHostRecovery({ config, destination: directory });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'recovery.json')));
  for (const service of manifest.metadata.services) recovery.systemctl(service, ['disable', '--now', service.name]);
  call('/usr/bin/loginctl', ['disable-linger', 'dispatchfixture']); call('/usr/bin/systemctl', ['stop', `user@${uid}.service`]);
  for (const account of manifest.metadata.accounts) { call('/usr/sbin/userdel', [account.name]); try { call('/usr/sbin/groupdel', [account.name]); } catch {} }
  for (const target of manifest.roots) fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync('/home/dispatchfixture', { recursive: true, force: true });
  const restored = await recovery.restoreHostRecovery({ directory, digest: proof.sha256 });
  await health();
  const after = new (require('node:sqlite').DatabaseSync)(path.join(localRoot, 'data/access-control/access-control.sqlite3'), { readOnly: true });
  if (!after.prepare('SELECT id FROM users WHERE id=?').get(owner.session.user.id) || after.prepare('SELECT count(*) AS n FROM organizations').get().n !== 2) throw Error('restored_database_mismatch');
  after.close();
  for (let i = 0; i < 2; i++) if (fs.readFileSync(path.join(plans[i].host.installationRoot, 'data/fixture-record'), 'utf8') !== `DSP ${i} private records`) throw Error('restored_dsp_mismatch');
  if (recovery.command('/usr/bin/systemctl', ['show', plans[1].identity.unitName, '--property=UnitFileState', '--value']) !== 'disabled') throw Error('suspended_dsp_enabled');
  if (fs.readFileSync('/etc/dispatch/fixture-secret', 'utf8') !== 'synthetic host secret') throw Error('restored_secret_mismatch');
  fs.rmSync(directory, { recursive: true });
  console.log(JSON.stringify({ ...restored, accountsRecreated: true, actualDashboard: true, actualDspHealth: true, suspendedDisabled: true }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
