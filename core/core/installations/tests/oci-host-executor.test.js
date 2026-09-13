'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { HOST_TENANT_ROOT, HOST_BRIDGE_ROOT } = require('../../runtime-host-identity');

// Isolate fixed host I/O; deployment-plan validation has its own real-contract
// tests. No account, systemd or Podman command is run by this unit harness.
function harness({ status = 'retired', occupied = false, redirectLayout = false, wrongRunningImage = false, starting = false, interruptedRemoval = false } = {}) {
  const root = '/synthetic-executor-state';
  const files = new Map();
  const commands = [];
  let containerInspections = 0, reloaded = false;
  const info = (mode, uid = process.geteuid(), directory = true) => ({
    uid, gid: uid, mode, nlink: 1, isDirectory: () => directory,
    isFile: () => !directory, isSymbolicLink: () => false,
  });
  for (const [file, mode, owner] of [[root, 0o700], ['/etc/systemd/system', 0o755],
    ['/synthetic-releases', 0o755], [HOST_TENANT_ROOT, 0o755, 0], [HOST_BRIDGE_ROOT, 0o711, 0]]) {
    files.set(file, { info: info(mode, owner) });
  }
  const fakeFs = {
    ...fs,
    lstatSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return files.get(file).info;
    },
    realpathSync: file => redirectLayout && file.includes('/runtime/runtime_executor_synthetic') ? '/outside/tenant-boundary' : file,
    mkdirSync: (file, options) => { files.set(file, { info: info(options.mode) }); },
    readFileSync: file => {
      if (['/etc/subuid', '/etc/subgid'].includes(file)) return '';
      return files.get(file)?.content || '';
    },
    writeFileSync: (file, content, options) => { files.set(file, { info: info(options.mode, undefined, false), content }); },
  };
  const file = path.resolve(__dirname, "../src/oci-host-executor.js");
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const realRequire = Module.createRequire(file);
  loaded.require = name => name === 'node:fs' ? fakeFs : name === './oci-host-artifact' ? { readRootFile: file => Buffer.from(fakeFs.readFileSync(file)) } : realRequire(name);
  loaded._compile(fs.readFileSync(file, 'utf8'), file);
  const runtimeKey = 'runtime_executor_synthetic';
  const { createOciDeploymentPlan, hostAccountName } = realRequire('./oci-deployment');
  const manifest = { manifestVersion: 1, revision: 1,
    organization: { id: 'org_executor', stationCode: 'SITE', timezone: 'UTC' },
    runtime: { key: runtimeKey, templateId: 'isolated_dsp_v1', releaseId: 'release_executor' } };
  const account = { name: hostAccountName(runtimeKey), uid: 29999, gid: 29999,
    subuidStart: 300000, subgidStart: 400000, subidCount: 65536 };
  files.set(`/run/user/${account.uid}`, { info: info(0o700, account.uid) });
  const release = { version: 2, backend: 'oci_container_v1', releaseId: 'release_executor',
    imageDigest: `sha256:${'a'.repeat(64)}`, imageId: 'f'.repeat(64), channel: 'production',
    image: `ghcr.io/example-organization/dispatch-runtime@sha256:${'a'.repeat(64)}`, sourceCommit: 'b'.repeat(40),
    platform: 'linux/amd64', runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1,
    embeddedManifestSha256: 'c'.repeat(64), imageArchiveSha256: 'd'.repeat(64), bridgeManifestSha256: 'e'.repeat(64) };
  const plan = createOciDeploymentPlan(manifest,
    { revision: 1, organization: manifest.organization, runtime: manifest.runtime }, release, account,
    { version: 1, backend: 'oci_container_v1', channel: 'production', organizationId: manifest.organization.id,
      runtimeKey, manifestRevision: 1, releaseId: release.releaseId });
  const { renderOciSystemUnit, renderOciBridgeSystemUnit } = realRequire('./oci-deployment');
  files.set(`/etc/systemd/system/${plan.identity.unitName}`, { info: info(0o644, 0, false), content: renderOciSystemUnit(plan) });
  files.set(`/etc/systemd/system/${plan.identity.bridgeUnitName}`, { info: info(0o644, 0, false), content: renderOciBridgeSystemUnit(plan, { bridgeExecutable: '/synthetic-releases/release_executor/bridge-artifact/core/agent-bridge/src/service-cli.js', centralSocket: '/synthetic-hub.sock', centralUid: 1001, controllerUid: 0 }) });
  if (interruptedRemoval) {
    files.set(`${root}/journals/${plan.identity.suffix}.json`, { info: info(0o600, process.geteuid(), false),
      content: JSON.stringify({ version: 2, planDigest: plan.planDigest,
        units: [plan.identity.bridgeUnitName, plan.identity.unitName].map(name => ({ name, existed: true,
          content: Buffer.from(files.get(`/etc/systemd/system/${name}`).content).toString('base64'),
          active: false, enabled: 'disabled' })) }) });
    files.delete(`/etc/systemd/system/${plan.identity.unitName}`);
  }
  if (status === 'retired') { files.delete(`/etc/systemd/system/${plan.identity.unitName}`); files.delete(`/etc/systemd/system/${plan.identity.bridgeUnitName}`); }
  const registry = { reserve() {}, inspect: () => ({ ...account, runtimeKey, status }), activate() {}, retire() {} };
  const execute = (command, args, settings) => {
    commands.push([command, args]);
    if (command === '/usr/bin/getent') {
      if (occupied && args[0] === 'passwd') return { status: 0, stdout: `${account.name}:x:123:123::/foreign:/bin/bash\n` };
      return { status: 2, stdout: '' };
    }
    if (command === '/usr/bin/systemctl' && args[0] === 'show') {
      const bridge = args[1] === plan.identity.bridgeUnitName;
      if (interruptedRemoval) return { status: 0, stdout:
        `LoadState=${!bridge && reloaded ? 'not-found' : 'loaded'}\nActiveState=inactive\nSubState=dead\nMainPID=0\nNeedDaemonReload=no\nDropInPaths=\nJob=\nFragmentPath=/etc/systemd/system/${args[1]}\n` };

      return { status: 0, stdout: `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nNeedDaemonReload=no\nDropInPaths=\nJob=\n`
        + `User=${bridge ? '0' : account.name}\nFragmentPath=/etc/systemd/system/${args[1]}\n` };
    }
    if (command === '/usr/bin/systemctl' && args[0] === 'daemon-reload') { reloaded = true; return { status: 0, stdout: '' }; }
    if (command === '/usr/bin/systemctl' && ['stop', 'enable'].includes(args[0])) return { status: 0, stdout: '' };
    if (command === '/usr/sbin/runuser') {
      assert.deepEqual(args.slice(0, 3), ['--user', account.name, '--']);
      if (args.includes('/usr/bin/install')) {
        const target = args.at(-1);
        const directory = args.includes('-d');
        files.set(target, { info: info(directory ? 0o700 : 0o600, account.uid, directory), content: settings.input });
        return { status: 0, stdout: '' };
      }
      if (args.includes('/usr/bin/dd')) {
        const target = args.find(arg => arg.startsWith('of=')).slice(3);
        files.set(target, { info: info(0o600, account.uid, false), content: settings.input });
        return { status: 0, stdout: '' };
      }
      if (args.includes('/usr/bin/cmp')) {
        const target = args.at(-2);
        return { status: files.get(target)?.content === settings.input ? 0 : 1, stdout: '' };
      }
      const podman = args.indexOf('/usr/bin/podman');
      if (podman !== -1) {
        const operation = args.slice(podman + 1, podman + 3).join(' ');
        if (operation === 'image inspect') return { status: 0, stdout: JSON.stringify([{
          Id: release.imageId, Digest: release.imageDigest, Architecture: 'amd64', Os: 'linux',
          Config: { User: '10001:10001' }, RepoDigests: [release.image],
          Labels: { 'org.opencontainers.image.revision': release.sourceCommit },
        }]) };
        if (operation === 'container inspect') return { status: 0, stdout: JSON.stringify([{
          Image: wrongRunningImage ? '0'.repeat(64) : release.imageId,
          Name: plan.identity.containerName, State: { Running: !starting || ++containerInspections > 1 },
          Config: { User: plan.security.user, Labels: { 'io.dispatch.runtime-key': runtimeKey,
            'io.dispatch.release-id': release.releaseId, 'io.dispatch.plan-digest': plan.planDigest } },
        }]) };
        if (args.includes('/opt/dispatch/runtime/supervisor/src/health.js')) return { status: 0, stdout: '' };
      }
    }
    throw new Error(`unexpected host command: ${command}`);
  };
  const executor = loaded.exports.createOciHostExecutor({ registry, stateRoot: root,
    unitRoot: '/etc/systemd/system', releaseRoot: '/synthetic-releases', centralSocket: '/synthetic-hub.sock',
    centralUid: 1001, controllerUid: 0, execute });
  return { executor, plan, files, commands };
}

test('destruction verification accepts the retired allocation and performs only absence queries', () => {
  const f = harness();
  assert.equal(f.executor.verifyDestroyed(f.plan).status, 'absent');
  assert.deepEqual(f.commands.map(([, args]) => args[0]), ['passwd', 'group']);
});

test('destruction verification cannot accept a still-active allocation', () => {
  const f = harness({ status: 'active' });
  assert.throws(() => f.executor.verifyDestroyed(f.plan), { code: 'runtime_identity_mismatch' });
  assert.equal(f.commands.length, 0);
});

test('account reconciliation refuses a foreign account before any group or filesystem mutation', () => {
  const f = harness({ status: 'reserved', occupied: true });
  let mutations = 0;
  assert.throws(() => f.executor.prepareAccount(f.plan, callback => { mutations += 1; return callback(); }),
    { code: 'runtime_identity_mismatch' });
  assert.equal(mutations, 0);
  assert.equal(f.commands.every(([command]) => command === '/usr/bin/getent'), true);
});

test('destruction rejects a substituted OS account before any destructive command', () => {
  const f = harness({ status: 'active', occupied: true });
  let mutations = 0;
  assert.throws(() => f.executor.destroyAccount(f.plan, callback => { mutations += 1; return callback(); }),
    { code: 'runtime_identity_mismatch' });
  assert.equal(mutations, 0);
  assert.equal(f.commands.every(([command]) => command === '/usr/bin/getent'), true);
});

test('destruction replay after retirement verifies absence without running commands as the deleted user', () => {
  const f = harness();
  let mutations = 0;
  assert.equal(f.executor.destroyAccount(f.plan, callback => { mutations += 1; return callback(); }).status, 'destroyed');
  assert.equal(mutations, 0);
});

test('layout directories and credentials are created only after dropping to the tenant identity', () => {
  const f = harness({ status: 'active' });
  const token = 'A'.repeat(43);
  assert.equal(f.executor.materializeLayout(f.plan, token, callback => callback()).changed, true);
  assert.equal(f.executor.materializeLayout(f.plan, token, callback => callback()).changed, false);
  assert.equal(f.commands.every(([command, args]) => command === '/usr/sbin/runuser' && args[1] === f.plan.account.name), true);
});

test('a redirected layout ancestor cannot cause root mkdir/chown outside the tenant boundary', () => {
  const f = harness({ status: 'active', redirectLayout: true });
  assert.throws(() => f.executor.materializeLayout(f.plan, 'A'.repeat(43), callback => callback()),
    { code: 'runtime_boundary_violation' });
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0][0], '/usr/sbin/runuser');
  assert.equal(f.commands[0][1][1], f.plan.account.name);
});

test('health rejects a different running release even when the requested image is cached', () => {
  const good = harness({ status: 'active' });
  assert.equal(good.executor.health(good.plan).status, 'healthy');
  const wrong = harness({ status: 'active', wrongRunningImage: true });
  assert.throws(() => wrong.executor.health(wrong.plan), { code: 'runtime_identity_mismatch' });
  assert.equal(wrong.commands.some(([, args]) => args.includes('/opt/dispatch/runtime/supervisor/src/health.js')), false);
});


test('health waits for a correctly identified container to enter running state', () => {
  const f = harness({ status: 'active', starting: true });
  assert.equal(f.executor.health(f.plan).status, 'healthy');
  assert.equal(f.commands.filter(([, args]) => args.includes('container')).length, 2);
});

test('a journal-authorized interrupted unlink reloads the inactive cached unit before recovery', () => {
  const f = harness({ status: 'active', interruptedRemoval: true });
  assert.equal(f.executor.stop(f.plan, callback => callback()).status, 'stopped');
  assert.equal(f.commands.filter(([, args]) => args[0] === 'daemon-reload').length, 1);
  assert.equal(f.commands.some(([, args]) => args[0] === 'stop' && args[1] === f.plan.identity.unitName), false);
});


test('initial start attests and enables both current units without reading a rollback snapshot', () => {
  const f = harness({ status: 'active' });
  assert.equal(f.executor.start(f.plan, callback => callback()).status, 'started');
  assert.deepEqual(f.commands.filter(([, args]) => args[0] === 'enable').map(([, args]) => args), [
    ['enable', '--now', f.plan.identity.bridgeUnitName], ['enable', '--now', f.plan.identity.unitName],
  ]);
});
