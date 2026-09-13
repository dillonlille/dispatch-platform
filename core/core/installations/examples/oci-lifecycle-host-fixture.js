'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { hostAccountName, opaqueRuntimeSuffix } = require('../../runtime-host-identity');
const { createOciDeploymentPlan } = require('../src/oci-deployment');
const REPO = path.resolve(__dirname, "../../..");
const KEYS = ['runtime_lifecycle_alpha', 'runtime_lifecycle_beta'];
const CONTROL = '/opt/dispatch-control';
const RELEASES = '/opt/dispatch-oci-fixture-releases';
const AUTHORITY = 'dispatch-lifecycle-authority';
const CALLER = 'dispatch-lifecycle-caller';
const HELPER = `${CONTROL}/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-helper`;
const ISSUER = `${CONTROL}/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-issuer`;
const ENV = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
function run(file, args, options = {}) {
  const value = spawnSync(file, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024, env: ENV, ...options });
  if (!options.allowFailure) assert.equal(value.status, 0, `${path.basename(file)} ${args[0]}: ${value.stderr}`);
  return value;
}
function removeTree(root) {
  function writable(directory) {
    fs.chmodSync(directory, 0o700);
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      if (fs.lstatSync(target).isDirectory()) writable(target);
    }
  }
  writable(root); fs.rmSync(root, { recursive: true });
}
function seal(root) {
  for (const name of fs.readdirSync(root)) {
    const target = path.join(root, name);
    if (fs.lstatSync(target).isDirectory()) seal(target);
  }
  fs.chmodSync(root, 0o555);
}
function hash(file) { return run('/usr/bin/sha256sum', [file], { timeout: 120_000 }).stdout.split(' ')[0]; }
async function lockedParent() {
  const lock = '/run/dispatch-rootless-host-fixture.lock';
  run('/usr/bin/sudo', ['-n', '/usr/bin/mkdir', '--mode=0700', lock]);
  try { return await parent(); }
  finally { run('/usr/bin/sudo', ['-n', '/usr/bin/rmdir', lock]); }
}
async function parent() {
  assert.equal(process.env.DISPATCH_RUN_OCI_LIFECYCLE_FIXTURE, '1', 'opt-in fixture required');
  assert.equal(fs.existsSync(CONTROL), false, 'existing control installation is preserved');
  const root = fs.mkdtempSync('/var/tmp/dispatch-full-lifecycle-');
  fs.chmodSync(root, 0o755);
  const images = [];
  try {
    for (const [name, script] of [['helper', 'create-host-helper-artifact.js'], ['bridge', 'create-bridge-artifact.js']]) {
      run('/usr/bin/node', [path.join(REPO, 'core/installations/src', script), path.join(root, name)]);
    }
    const build = path.join(root, 'build'); fs.mkdirSync(build, { mode: 0o755 });
    fs.copyFileSync(path.join(REPO, 'plugins/paycom/backend/tests/oci-lifecycle-seed.js'), path.join(build, 'seed.js'));
    fs.copyFileSync(path.join(REPO, 'runtime/collection-manager/tests/fixture-collector.js'), path.join(build, 'collector'));
    fs.chmodSync(path.join(build, 'collector'), 0o755);
    fs.copyFileSync(path.join(REPO, 'plugins/paycom/backend/tests/helpers.js'), path.join(build, 'helpers.js'));
    const releases = {};
    for (const [index, id] of ['dispatch_current_1', 'dispatch_fixture_2'].entries()) {
      const tag = `ghcr.io/example-organization/dispatch-runtime:fixture-${process.pid}-${index}`;
      fs.writeFileSync(path.join(build, 'Containerfile'), `FROM localhost/dispatch-runtime:dev\nUSER 0:0\nCOPY seed.js /opt/dispatch/fixture-seed.js\nCOPY helpers.js /opt/dispatch/plugins/paycom/backend/tests/helpers.js\nCOPY --chown=10001:10001 --chmod=0555 collector /opt/dispatch/fixture-collector\nLABEL io.dispatch.synthetic-fixture="${index}"\nUSER 10001:10001\nHEALTHCHECK --interval=30s --timeout=30s --start-period=30s --retries=3 CMD ["/usr/local/bin/node", "--no-warnings", "/opt/dispatch/runtime/supervisor/src/health.js"]\n`);
      run('/usr/bin/podman', ['build', '--format=docker', '--pull=never', '--network=none', '-t', tag, build], { timeout: 300_000 });
      images.push(tag);
      const inspected = JSON.parse(run('/usr/bin/podman', ['image', 'inspect', tag]).stdout)[0];
      assert.deepEqual(inspected.Healthcheck.Test, ['CMD', '/usr/local/bin/node', '--no-warnings', '/opt/dispatch/runtime/supervisor/src/health.js']);
      const archive = path.join(root, `${id}.tar`);
      run('/usr/bin/podman', ['save', '--format', 'oci-archive', '--output', archive, tag], { timeout: 300_000 });
      const archiveIndex = JSON.parse(run('/usr/bin/tar', ['-xOf', archive, 'index.json']).stdout);
      const exportedDigest = archiveIndex.manifests[0].digest;
      const exportedManifest = JSON.parse(run('/usr/bin/tar', ['-xOf', archive, `blobs/sha256/${exportedDigest.slice(7)}`]).stdout);
      const embedded = run('/usr/bin/podman', ['run', '--rm', '--pull=never', '--network=none', '--read-only',
        '--entrypoint=/usr/bin/sha256sum', tag, '/opt/dispatch/runtime-release-manifest.json']).stdout.split(' ')[0];
      releases[id] = { version: 2, backend: 'oci_container_v1', releaseId: id, channel: 'production',
        image: `ghcr.io/example-organization/dispatch-runtime@${exportedDigest}`, imageDigest: exportedDigest,
        imageId: exportedManifest.config.digest.slice(7), sourceCommit: inspected.Labels['org.opencontainers.image.revision'], platform: 'linux/amd64',
        runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1, embeddedManifestSha256: embedded,
        imageArchiveSha256: hash(archive), bridgeManifestSha256: hash(path.join(root, 'bridge/manifest.json')) };
    }
    releases.dispatch_fixture_3 = { ...releases.dispatch_fixture_2, releaseId: 'dispatch_fixture_3' };
    fs.writeFileSync(path.join(root, 'releases.json'), JSON.stringify(releases));
    const child = spawn('/usr/bin/sudo', ['-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
      '/usr/bin/node', '--no-warnings', __filename, '--root', root], { stdio: ['ignore', 'inherit', 'inherit'] });
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
  } finally {
    for (const tag of images) run('/usr/bin/podman', ['image', 'rm', tag], { allowFailure: true });
    removeTree(root);
  }
}
async function rootMain(source) {
  assert.equal(process.geteuid(), 0);
  process.umask(0o077);
  assert.match(source, /^\/var\/tmp\/dispatch-full-lifecycle-[a-zA-Z0-9]+$/);
  for (const file of [CONTROL, RELEASES, '/etc/dispatch/oci-host.json']) assert.equal(fs.existsSync(file), false);
  for (const account of [AUTHORITY, CALLER, ...KEYS.map(hostAccountName)]) {
    assert.equal(run('/usr/bin/getent', ['passwd', account], { allowFailure: true }).status, 2);
    assert.equal(run('/usr/bin/getent', ['group', account], { allowFailure: true }).status, 2);
  }
  const references = ['dispatch-auth-broker.service', 'dispatch-collection-manager.service'];
  const reference = () => references.map(name => run('/usr/bin/systemctl', ['show', name, '--property=MainPID,ActiveState']).stdout);
  const referenceBefore = reference();
  const createdDirs = [];
  const accounts = [];
  const policies = [];
  let configCreated = false;
  const privateRoot = fs.mkdtempSync('/run/dispatch-full-lifecycle-'); fs.chmodSync(privateRoot, 0o755);
  const releases = JSON.parse(fs.readFileSync(path.join(source, 'releases.json')));
  const makeDir = (target, mode, owner = 0) => {
    fs.mkdirSync(target, { mode }); fs.chmodSync(target, mode); fs.chownSync(target, owner, owner); return target;
  };
  const ensureDir = (target, mode) => {
    if (!fs.existsSync(target)) { makeDir(target, mode); createdDirs.push(target); }
    const stat = fs.lstatSync(target); assert.equal(stat.uid, 0); assert.equal(stat.gid, 0);
    assert.equal(stat.mode & 0o7777, mode); assert.equal(fs.realpathSync(target), target);
  };
  let controllerRoot;
  function plan(index, releaseId = 'dispatch_current_1', revision = 1) {
    const db = new DatabaseSync(path.join(privateRoot, 'state/oci-host.sqlite3'), { readOnly: true });
    let row;
    try { row = db.prepare('SELECT * FROM allocations WHERE runtime_key=?').get(KEYS[index]); } finally { db.close(); }
    if (!row) throw new Error('fixture allocation missing');
    const manifest = { manifestVersion: 1, revision, organization: { id: `org_lifecycle_${index}`, stationCode: 'TEST', timezone: 'UTC' },
      runtime: { key: KEYS[index], templateId: 'isolated_dsp_v1', releaseId } };
    return createOciDeploymentPlan(manifest, { revision, organization: manifest.organization, runtime: manifest.runtime },
      releases[releaseId], { name: row.account_name, uid: row.uid, gid: row.gid, subuidStart: row.subuid_start,
        subgidStart: row.subgid_start, subidCount: row.subid_count },
      { version: 1, backend: 'oci_container_v1', channel: 'production', organizationId: manifest.organization.id,
        runtimeKey: KEYS[index], manifestRevision: revision, releaseId });
  }
  const asTenant = (selected, executable, args, options = {}) => run('/usr/sbin/runuser', ['--user', selected.account.name,
    '--', '/usr/bin/env', '-i', `HOME=${selected.host.accountHome}`, `XDG_DATA_HOME=${selected.host.engineDataRoot}`,
    `XDG_CONFIG_HOME=${selected.host.engineConfigRoot}`, `XDG_RUNTIME_DIR=/run/user/${selected.account.uid}`,
    'PATH=/usr/bin:/bin', executable, ...args], options);
  function fixtureAction(message) {
    if (Number.isInteger(message.seed)) {
      const selected = plan(message.seed);
      const result = asTenant(selected, '/usr/bin/podman', ['exec', selected.identity.containerName,
        '/usr/local/bin/node', '--no-warnings', '/opt/dispatch/fixture-seed.js', ...(message.changed ? ['--changed'] : [])]);
      asTenant(selected, '/usr/bin/tee', [path.join(selected.host.installationRoot, 'data/fixture-sentinel')], { input: 'before\n' });
      return { ok: true, ...JSON.parse(result.stdout) };
    }
    if (message.inspectBeta) {
      const selected = plan(1);
      return { pid: run('/usr/bin/systemctl', ['show', selected.identity.unitName, '--property=MainPID', '--value']).stdout.trim(),
        sentinel: asTenant(selected, '/usr/bin/cat', [path.join(selected.host.installationRoot, 'data/fixture-sentinel')]).stdout };
    }
    if (message.destroyed) {
      assert.equal(fs.existsSync(`/var/lib/dispatch/tenants/${opaqueRuntimeSuffix(KEYS[0])}`), false);
      assert.equal(run('/usr/bin/getent', ['passwd', hostAccountName(KEYS[0])], { allowFailure: true }).status, 2);
      return { ok: true };
    }
    const selected = plan(0);
    const sentinel = path.join(selected.host.installationRoot, 'data/fixture-sentinel');
    if (message.mutateSentinel) { asTenant(selected, '/usr/bin/tee', [sentinel], { input: 'after\n' }); return { ok: true }; }
    if (message.verifySentinel) { assert.equal(asTenant(selected, '/usr/bin/cat', [sentinel]).stdout, 'before\n'); return { ok: true }; }
    if (message.retained) { assert.equal(fs.existsSync(selected.host.installationRoot), true); return { ok: true }; }
    throw new Error('invalid fixture action');
  }
  try {
    for (const name of [AUTHORITY, CALLER]) {
      run('/usr/sbin/useradd', ['--system', '--user-group', '--no-create-home', '--shell', '/usr/sbin/nologin', name]); accounts.push(name);
    }
    const uid = name => Number(run('/usr/bin/id', ['-u', name]).stdout.trim());
    const authorityUid = uid(AUTHORITY), callerUid = uid(CALLER);
    controllerRoot = makeDir(path.join(privateRoot, 'controller'), 0o700, authorityUid);
    for (const name of ['credentials', 'provisioner', 'unused-installations']) makeDir(path.join(controllerRoot, name), 0o700, authorityUid);
    makeDir(path.join(privateRoot, 'authority'), 0o700); makeDir(path.join(privateRoot, 'state'), 0o700);
    ensureDir('/var/lib/dispatch', 0o755); ensureDir('/var/lib/dispatch/tenants', 0o755); ensureDir('/run/dispatch-runtime-agents', 0o711);
    ensureDir('/etc/dispatch', 0o755);
    makeDir(CONTROL, 0o755); makeDir(`${CONTROL}/releases`, 0o755); makeDir(`${CONTROL}/releases/synthetic-oci-control`, 0o755);
    const artifact = `${CONTROL}/releases/synthetic-oci-control/host-helper-artifact`;
    fs.cpSync(path.join(source, 'helper'), artifact, { recursive: true }); seal(artifact); seal(`${CONTROL}/releases/synthetic-oci-control`);
    fs.symlinkSync(`${CONTROL}/releases/synthetic-oci-control`, `${CONTROL}/current`);
    makeDir(RELEASES, 0o755);
    for (const id of Object.keys(releases)) {
      const root = makeDir(path.join(RELEASES, id), 0o755);
      fs.cpSync(path.join(source, 'bridge'), path.join(root, 'bridge-artifact'), { recursive: true }); seal(path.join(root, 'bridge-artifact'));
      fs.copyFileSync(path.join(source, `${id === 'dispatch_fixture_3' ? 'dispatch_fixture_2' : id}.tar`), path.join(root, 'runtime-image.tar'));
      fs.chownSync(path.join(root, 'runtime-image.tar'), 0, 0);
      fs.chmodSync(path.join(root, 'runtime-image.tar'), 0o444); seal(root);
    }
    const config = { stateRoot: path.join(privateRoot, 'state'), authorityRoot: path.join(privateRoot, 'authority'),
      unitRoot: '/etc/systemd/system', releaseRoot: RELEASES, centralSocket: path.join(controllerRoot, 'runtime-agent-hub.sock'),
      centralUid: authorityUid, controllerUid: 0, authorityUid, helperCallerUid: callerUid, helperCallerGid: callerUid,
      controlReleaseId: 'synthetic-oci-control', helperManifestSha256: hash(path.join(artifact, 'manifest.json')) };
    fs.writeFileSync('/etc/dispatch/oci-host.json', JSON.stringify(config), { flag: 'wx', mode: 0o600 }); configCreated = true;
    for (const [name, executable] of [[AUTHORITY, ISSUER], [CALLER, HELPER]]) {
      const policy = `/etc/sudoers.d/${name}`;
      fs.writeFileSync(policy, `Defaults:${name} env_reset,!setenv,secure_path="/usr/bin:/bin"\n`
        + `Defaults:${name} env_delete += "NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH"\n`
        + `${name} ALL=(root) NOPASSWD: NOSETENV: ${executable} ""\n`, { mode: 0o440, flag: 'wx' });
      fs.chmodSync(policy, 0o440);
      policies.push(policy); run('/usr/sbin/visudo', ['-cf', policy]);
    }
    const workerConfig = path.join(controllerRoot, 'fixture.json');
    fs.writeFileSync(workerConfig, JSON.stringify({ controllerRoot, releases, centralSocket: config.centralSocket,
      controlSocket: path.join(controllerRoot, 'runtime-agent-control.sock') }), { mode: 0o600 });
    fs.chownSync(workerConfig, authorityUid, authorityUid);
    const worker = spawn('/usr/sbin/runuser', ['--user', AUTHORITY, '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
      '/usr/bin/node', '--no-warnings', path.join(__dirname, "./helpers/oci-lifecycle-worker.js"), workerConfig], { stdio: ['pipe', 'pipe', 'inherit'] });
    const output = readline.createInterface({ input: worker.stdout });
    let actionError;
    output.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.phase) {
          process.stdout.write(`${JSON.stringify(value)}\n`);

        }
        else worker.stdin.write(`${JSON.stringify(fixtureAction(value))}\n`);
      } catch (error) { actionError = error; worker.stdin.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); }
    });
    const status = await new Promise(resolve => worker.once('exit', resolve));
    if (actionError) throw actionError;
    assert.equal(status, 0, 'lifecycle authority worker failed');
  } finally {
    for (const key of KEYS) {
      const name = hostAccountName(key), suffix = opaqueRuntimeSuffix(key);
      for (const unit of [`dispatch-dsp-${suffix}.service`, `dispatch-runtime-agent-bridge-${suffix}.service`]) {
        run('/usr/bin/systemctl', ['disable', '--now', unit], { allowFailure: true });
        fs.rmSync(`/etc/systemd/system/${unit}`, { force: true });
        run('/usr/bin/systemctl', ['reset-failed', unit], { allowFailure: true });
      }
      if (run('/usr/bin/getent', ['passwd', name], { allowFailure: true }).status === 0) {
        const index = KEYS.indexOf(key); const selected = plan(index);
        asTenant(selected, '/usr/bin/podman', ['system', 'reset', '--force'], { allowFailure: true });
        run('/usr/bin/loginctl', ['disable-linger', name], { allowFailure: true });
        run('/usr/bin/systemctl', ['stop', `user@${selected.account.uid}.service`, `user-runtime-dir@${selected.account.uid}.service`], { allowFailure: true });
        run('/usr/sbin/usermod', ['--del-subuids', `${selected.account.subuidStart}-${selected.account.subuidStart + 65535}`,
          '--del-subgids', `${selected.account.subgidStart}-${selected.account.subgidStart + 65535}`, name], { allowFailure: true });
        run('/usr/sbin/userdel', [name]);
        if (run('/usr/bin/getent', ['group', name], { allowFailure: true }).status === 0) run('/usr/sbin/groupdel', [name]);
        fs.rmSync(selected.host.tenantRoot, { recursive: true, force: true });
        fs.rmSync(selected.host.bridgeRoot, { recursive: true, force: true });
      }
      assert.equal(run('/usr/bin/getent', ['passwd', name], { allowFailure: true }).status, 2);
      for (const file of ['/etc/subuid', '/etc/subgid']) assert.equal(fs.readFileSync(file, 'utf8').includes(`${name}:`), false);
    }
    run('/usr/bin/systemctl', ['daemon-reload']);
    for (const policy of policies) fs.unlinkSync(policy);
    if (configCreated) fs.unlinkSync('/etc/dispatch/oci-host.json');
    for (const name of accounts.reverse()) {
      run('/usr/sbin/userdel', [name]);
      if (run('/usr/bin/getent', ['group', name], { allowFailure: true }).status === 0) run('/usr/sbin/groupdel', [name]);
    }
    for (const root of [CONTROL, RELEASES]) if (fs.existsSync(root)) removeTree(root);
    fs.rmSync(privateRoot, { recursive: true, force: true });
    for (const directory of createdDirs.reverse()) fs.rmdirSync(directory);
    assert.deepEqual(reference(), referenceBefore);
  }
  process.stdout.write(`${JSON.stringify({ status: 'oci_lifecycle_fixture_verified', tenants: 2, artifactsRemaining: 0 })}\n`);
}
(process.argv[2] === '--root' ? rootMain(process.argv[3]) : process.env.DISPATCH_RUN_OCI_LIFECYCLE_FIXTURE === '1'
  ? lockedParent() : Promise.resolve()).catch(error => {
  process.stderr.write(`${error.stack}\n`); process.exitCode = 1;
});
