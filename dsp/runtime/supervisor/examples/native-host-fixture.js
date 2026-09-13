'use strict';
// Disposable two-account integration fixture. Never selects a dashboard DSP.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const execute = require('node:util').promisify(execFile);
const { createOciFixtureDeploymentPlan, renderOciSystemUnit, renderOciBridgeSystemUnit, hostAccountName } = require('dispatch-core/core/installations/src/oci-deployment.js');
const { MANAGED_INSTALLATION_DIRECTORY_FIELDS } = require('dispatch-protocol/paths/runtime-paths');
const { CoreRuntimeAgentHub, createRuntimeAgentDispatchClient } = require('dispatch-core/core/agents/src/index.js');
const ROOT = path.resolve(__dirname, "../../..");
const RELEASE = '/opt/dispatch-runtime/releases/dispatch_native_fixture';
async function run(command, args, options = {}) {
  return execute(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16384, ...options });
}
const sudo = (command, args, options) => run('/usr/bin/sudo', ['-n', command, ...args], options);
async function main(packageDirectory) {
  if (!path.isAbsolute(packageDirectory) || fs.realpathSync(packageDirectory) !== packageDirectory
      || fs.existsSync(RELEASE) || process.geteuid() === 0) throw Error('fixture_precondition');
  const release = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'descriptor.json')));
  if (release.releaseId !== 'dispatch_native_fixture' || release.channel !== 'fixture') throw Error('fixture_package_invalid');
  const temporary = fs.mkdtempSync('/tmp/dispatch-native-host-'); fs.chmodSync(temporary, 0o700);
  const centralRoot = `/run/user/${process.geteuid()}/dispatch-native-fixture-${process.pid}`;
  fs.mkdirSync(centralRoot, { mode: 0o700 });
  const centralSocket = path.join(centralRoot, 'runtime-agent-hub.sock');
  const plans = [], accounts = [], units = [], authorities = {};
  const profile = '/etc/apparmor.d/dispatch-native-chrome', profileExisted = fs.existsSync(profile);
  let hub;
  try {
    const bridge = path.join(temporary, 'bridge-artifact');
    require('dispatch-core/core/installations/src/create-bridge-artifact.js').main([bridge]);
    if (require('dispatch-core/core/installations/src/release-delivery-files.js').hashFileSync(path.join(bridge, 'manifest.json')) !== release.bridgeManifestSha256) throw Error('fixture_bridge_mismatch');
    await sudo('/usr/bin/install', ['-d', '-m', '0755', RELEASE]);
    await sudo('/usr/bin/node', ['--no-warnings', '-e', `const x=require(${JSON.stringify(path.join(ROOT, 'core/installations/src/native-runtime-artifact'))});x.unpackNativeRuntime(process.argv[1],process.argv[2],JSON.parse(require('node:fs').readFileSync(process.argv[3])));`,
      path.join(packageDirectory, 'runtime.tar.gz'), path.join(RELEASE, 'runtime-artifact'), path.join(packageDirectory, 'descriptor.json')]);
    await sudo('/usr/bin/cp', ['-R', bridge, path.join(RELEASE, 'bridge-artifact')]);
    const diagnostic = path.join(temporary, 'diagnostic.js');
    fs.writeFileSync(diagnostic, `const fs=require('node:fs');const s=require('/opt/dispatch/runtime/supervisor/src/supervisor');try { const c=s.configuration();s.assertMountBoundary(c);console.log('native_boundary_verified');const {CollectionStore}=require('/opt/dispatch/runtime/collection-manager/src/store');const paths=require('/opt/dispatch/runtime/collection-manager/src/paths').defaultPaths();if(fs.existsSync(paths.database)){try{const store=new CollectionStore(paths);console.log('collection_storage_verified');store.close();}catch(e){console.error('fixture_collection_storage:'+e.message);throw e;}} } catch(e) { console.error(e.code);console.error(fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n').filter(l=>/ \\/( |tmp |opt\\/dispatch |run\\/dispatch-agent |var\\/lib\\/dispatch\\/runtime_)/.test(l)).join('\\n'));process.exitCode=1; }`);
    await sudo('/usr/bin/install', ['-m', '0444', diagnostic, path.join(RELEASE, 'diagnostic.js')]);
    await sudo('/usr/bin/chown', ['-R', 'root:root', RELEASE]);
    await sudo('/usr/bin/chmod', ['0555', RELEASE]);
    await sudo('/usr/bin/node', ['--no-warnings', '-e', `require(${JSON.stringify(path.join(ROOT, 'core/installations/src/release-delivery-install'))}).installBrowserSandboxProfile()`]);
    for (let i = 0; i < 2; i++) {
      const key = `runtime_native_fixture_${i ? 'beta' : 'alpha'}`, uid = 20501 + i, name = hostAccountName(key);
      for (const [database, identity] of [['passwd', name], ['passwd', String(uid)], ['group', name], ['group', String(uid)]]) {
        try { await run('/usr/bin/getent', [database, identity]); throw Error('fixture_account_exists'); }
        catch (error) { if (error.code !== 2) throw error; }
      }
      const manifest = { manifestVersion: 1, revision: 1, organization: { id: `org_native_fixture_${i}`, stationCode: 'DXX1', timezone: 'America/Chicago' },
        runtime: { key, templateId: 'isolated_dsp_v1', releaseId: release.releaseId } };
      const authority = { revision: 1, organization: manifest.organization, runtime: manifest.runtime };
      const plan = createOciFixtureDeploymentPlan(manifest, authority, release,
        { name, uid, gid: uid, subuidStart: 300000 + i * 65536, subgidStart: 300000 + i * 65536, subidCount: 65536 },
        { version: 1, backend: release.backend, channel: 'fixture', organizationId: manifest.organization.id,
          runtimeKey: key, manifestRevision: 1, releaseId: release.releaseId });
      if (fs.existsSync(plan.host.tenantRoot) || fs.existsSync(plan.host.bridgeRoot)
          || fs.existsSync(plan.host.unitPath) || fs.existsSync(plan.host.bridgeUnitPath)) throw Error('fixture_path_exists');
      await sudo('/usr/sbin/groupadd', ['--system', '--gid', String(uid), name]);
      accounts.push(name); plans.push(plan);
      await sudo('/usr/sbin/useradd', ['--system', '--uid', String(uid), '--gid', String(uid), '--home-dir', plan.host.accountHome,
        '--no-create-home', '--shell', '/usr/sbin/nologin', name]);
      for (const directory of [plan.host.tenantRoot, plan.host.accountHome, path.dirname(plan.host.installationRoot), plan.host.installationRoot,
        ...Object.values(MANAGED_INSTALLATION_DIRECTORY_FIELDS).map(p => path.join(plan.host.installationRoot, p))]) {
        await sudo('/usr/bin/install', ['-d', '-o', name, '-g', name, '-m', '0700', directory]);
      }
      await sudo('/usr/bin/install', ['-d', '-o', 'root', '-g', 'root', '-m', '0711', plan.host.bridgeRoot]);
      const token = crypto.randomBytes(32).toString('base64url'), tokenFile = path.join(temporary, `token-${i}`);
      authorities[key] = crypto.createHash('sha256').update(token).digest('hex');
      fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
      await sudo('/usr/bin/install', ['-o', name, '-g', name, '-m', '0600', tokenFile, path.join(plan.host.installationRoot, 'secrets/runtime-agent/registration-token')]);
    }
    hub = new CoreRuntimeAgentHub({ socketPath: centralSocket, authorities, collectionCapacity: { workers: 1, recoveryMs: 0 } });
    await hub.start();
    for (const plan of plans) {
      const bridge = renderOciBridgeSystemUnit(plan, { bridgeExecutable: path.join(RELEASE, 'bridge-artifact/core/agent-bridge/src/service-cli.js'),
        centralSocket, centralUid: process.geteuid(), controllerUid: 0 });
      const runtimeUnit = renderOciSystemUnit(plan).replace('ExecStart=', `ExecStartPre=/opt/dispatch/dependencies/node/bin/node ${RELEASE}/diagnostic.js\nExecStart=`);
      for (const [name, content] of [[plan.identity.bridgeUnitName, bridge], [plan.identity.unitName, runtimeUnit]]) {
        const file = path.join(temporary, name); fs.writeFileSync(file, content);
        await sudo('/usr/bin/install', ['-m', '0644', file, `/run/systemd/system/${name}`]); units.push(name);
      }
    }
    await sudo('/usr/bin/systemctl', ['daemon-reload']);
    await sudo('/usr/bin/systemctl', ['start', ...units]);
    for (const plan of plans) {
      const client = createRuntimeAgentDispatchClient({ runtimeKey: plan.runtimeKey, hub });
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { const response = await client.health(); if (response.ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw Error(`fixture_runtime_unhealthy:${plan.identity.suffix}`);
    }
    const first = plans[0], second = plans[1];
    const pid = (await sudo('/usr/bin/systemctl', ['show', first.identity.unitName, '--property=MainPID', '--value'])).stdout.trim();
    if (!/^[1-9][0-9]*$/.test(pid)) throw Error('fixture_pid_invalid');
    const probe = `const fs=require('node:fs');const {ChromeBrowserRuntime}=require('/opt/dispatch/runtime/auth-broker/src/browser-runtime');const {createTarget,CdpConnection}=require('/opt/dispatch/runtime/auth-broker/src/cdp');(async()=>{const browser=await new ChromeBrowserRuntime({stateRoot:process.env.DISPATCH_AUTH_STATE_ROOT,socketRoot:process.env.DISPATCH_RUNTIME_ROOT,executable:'/opt/dispatch/dependencies/browser/chrome',transport:'pipe'}).launch();try{const target=await createTarget(browser.endpoint,'about:blank');const connection=await CdpConnection.connect(target.webSocketDebuggerUrl);let value;try{value=await connection.evaluate('6*7');}finally{connection.close();}if(value!==42)throw Error('browser_evaluation_failed');if(fs.existsSync(${JSON.stringify(second.host.installationRoot)}))throw Error('cross_dsp_access');console.log(JSON.stringify({privateBrowser:true,result:value,separateData:true}));}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});`;
    const output = await sudo('/usr/bin/nsenter', ['--target', pid, '--mount', `--setuid=${first.account.uid}`, `--setgid=${first.account.gid}`, '--',
      '/usr/bin/env', '-i', 'PATH=/opt/dispatch/dependencies/node/bin:/usr/bin:/bin', 'HOME=/tmp',
      ...Object.entries(first.guest.environment).map(([k, v]) => `${k}=${v}`), '/opt/dispatch/dependencies/node/bin/node', '--no-warnings', '-e', probe]);
    process.stdout.write(output.stdout);
    const capacity = async (plan, operation) => {
      const processId = (await sudo('/usr/bin/systemctl', ['show', plan.identity.unitName, '--property=MainPID', '--value'])).stdout.trim();
      const script = `require('/opt/dispatch/runtime/collection-manager/src/capacity-runner').queryCapacity(process.env.DISPATCH_RUNTIME_AGENT_STATUS_SOCKET,{operation:${JSON.stringify(operation)},jobId:'a'.repeat(32),workers:6}).then(value=>console.log(JSON.stringify(value))).catch(()=>{process.exitCode=1});`;
      const result = await sudo('/usr/bin/nsenter', ['--target', processId, '--mount', `--setuid=${plan.account.uid}`, `--setgid=${plan.account.gid}`, '--',
        '/usr/bin/env', '-i', 'PATH=/opt/dispatch/dependencies/node/bin:/usr/bin:/bin', 'HOME=/tmp',
        ...Object.entries(plan.guest.environment).map(([key, value]) => `${key}=${value}`), '/opt/dispatch/dependencies/node/bin/node', '--no-warnings', '-e', script]);
      return JSON.parse(result.stdout);
    };
    if ((await capacity(first, 'acquire')).workers !== 1 || (await capacity(second, 'acquire')).status !== 'waiting') throw Error('fixture_capacity_isolation_failed');
    await capacity(first, 'release');
    if ((await capacity(second, 'acquire')).workers !== 1) throw Error('fixture_capacity_handoff_failed');
    await capacity(second, 'release');
    process.stdout.write(JSON.stringify({ sharedCapacity: true, privateAgentBridges: true }) + '\n');
    await sudo('/usr/bin/systemctl', ['stop', first.identity.unitName]);
    const other = await createRuntimeAgentDispatchClient({ runtimeKey: second.runtimeKey, hub }).health();
    if (!other.ok) throw Error('fixture_other_dsp_interrupted');
    await sudo('/usr/bin/systemctl', ['stop', ...units]);
    const recovery = path.join(temporary, 'recovery'), capsuleModule = path.join(ROOT, 'core/installations/src/recovery-capsule');
    const roots = [{ source: RELEASE, target: RELEASE }, ...plans.map(plan => ({ source: plan.host.tenantRoot, target: plan.host.tenantRoot,
      excludeContents: [`runtime/${plan.runtimeKey}/run`] })),
      ...units.map(name => ({ source: `/run/systemd/system/${name}`, target: `/run/systemd/system/${name}` }))];
    const captured = await sudo('/usr/bin/node', ['--no-warnings', '-e',
      `const c=require(${JSON.stringify(capsuleModule)});const roots=JSON.parse(process.argv[2]);const proof=c.capture(process.argv[1],roots,{kind:'native-fixture'},new Set([0,20501,20502]));c.verify(process.argv[1],proof.sha256,new Set(roots.map(r=>r.target)));console.log(JSON.stringify(proof));`, recovery, JSON.stringify(roots)]);
    const proof = JSON.parse(captured.stdout);
    for (const name of accounts) {
      await sudo('/usr/sbin/userdel', [name]);
      await sudo('/usr/sbin/groupdel', [name]).catch(error => { if (error.code !== 6) throw error; });
    }
    for (const selected of roots) await sudo('/usr/bin/rm', ['-rf', '--', selected.target]);
    for (const plan of plans) {
      await sudo('/usr/sbin/groupadd', ['--system', '--gid', String(plan.account.gid), plan.account.name]);
      await sudo('/usr/sbin/useradd', ['--system', '--uid', String(plan.account.uid), '--gid', String(plan.account.gid),
        '--home-dir', plan.host.accountHome, '--no-create-home', '--shell', '/usr/sbin/nologin', plan.account.name]);
    }
    await sudo('/usr/bin/node', ['--no-warnings', '-e',
      `require(${JSON.stringify(capsuleModule)}).installFresh(process.argv[1],process.argv[2],new Set(JSON.parse(process.argv[3])));`,
      recovery, proof.sha256, JSON.stringify(roots.map(r => r.target))]);
    await sudo('/usr/bin/systemctl', ['daemon-reload']);
    await sudo('/usr/bin/systemctl', ['start', ...units]);
    for (const plan of plans) {
      let healthy = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { if ((await createRuntimeAgentDispatchClient({ runtimeKey: plan.runtimeKey, hub }).health()).ok) { healthy = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!healthy) throw Error('fixture_restored_runtime_unhealthy');
    }
    await sudo('/usr/bin/rm', ['-rf', '--', recovery]);
    process.stdout.write(JSON.stringify({ status: 'native_host_verified', dsps: plans.length, independentStop: true, restoredCodeDataAccountsAndServices: true }) + '\n');
  } catch (error) {
    for (const name of units) {
      const log = await sudo('/usr/bin/journalctl', ['-u', name, '-n', '8', '--no-pager']).catch(() => null);
      if (log) process.stderr.write(log.stdout);
    }
    throw error;
  } finally {
    await sudo('/usr/bin/rm', ['-rf', '--', path.join(temporary, 'recovery')]).catch(() => {});
    for (const name of [...units].reverse()) await sudo('/usr/bin/systemctl', ['stop', name]).catch(() => {});
    await hub?.close();
    for (const name of units) await sudo('/usr/bin/rm', ['-f', `/run/systemd/system/${name}`]);
    await sudo('/usr/bin/systemctl', ['daemon-reload']);
    for (const name of accounts) {
      await sudo('/usr/sbin/userdel', [name]).catch(() => {});
      await sudo('/usr/sbin/groupdel', [name]).catch(() => {});
    }
    for (const plan of plans) await sudo('/usr/bin/rm', ['-rf', '--one-file-system', plan.host.tenantRoot, plan.host.bridgeRoot]);
    await sudo('/usr/bin/rm', ['-rf', '--one-file-system', RELEASE]);
    if (!profileExisted && fs.existsSync(profile)) {
      await sudo('/usr/sbin/apparmor_parser', ['-R', profile]).catch(() => {});
      await sudo('/usr/bin/rm', ['-f', profile]);
    }
    require('dispatch-core/core/installations/src/release-delivery-install.js').removeStage(temporary);
    fs.rmSync(centralRoot, { recursive: true, force: true });
  }
}
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
