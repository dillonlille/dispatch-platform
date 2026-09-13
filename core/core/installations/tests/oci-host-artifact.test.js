'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { verifyHostArtifact, verifyPreparedHostArtifact } = require('../src/oci-host-artifact');
const { createOciHostAuthority, ISSUER, AUDIENCE } = require('../src/oci-host-authority');

function removeTree(root) {
  const writable = directory => {
    fs.chmodSync(directory, 0o700);
    for (const name of fs.readdirSync(directory)) {
      const child = path.join(directory, name);
      if (fs.lstatSync(child).isDirectory()) writable(child);
    }
  };
  writable(root);
  fs.rmSync(root, { recursive: true });
}

if (process.geteuid() !== 0) {
  test('production-style root-owned helper artifact verifies its complete tree and current pointer', t => {
    if (fs.existsSync('/opt/dispatch-control')) return t.skip('existing control installation is preserved');
    if (spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/true']).status !== 0) return t.skip('requires noninteractive sudo');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-artifact-test-'));
    t.after(() => removeTree(root));
    const target = path.join(root, 'artifact');
    const built = spawnSync('/usr/bin/node', [path.resolve(__dirname, "../src/create-host-helper-artifact.js"), target],
      { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const result = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
      `DISPATCH_SYNTHETIC_ARTIFACT=${target}`, '/usr/bin/node', '--no-warnings', '--test', __filename],
    { encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync('/opt/dispatch-control'), false);
  });
} else {
  test('immutable helper rejects altered content, modes, links and current redirection', t => {
    const control = '/opt/dispatch-control';
    // mkdir is exclusive: never adopt or remove an existing installation.
    fs.mkdirSync(control, { mode: 0o755 });
    const identity = fs.lstatSync(control);
    t.after(() => {
      const current = fs.lstatSync(control);
      assert.equal(current.ino, identity.ino);
      assert.equal(current.dev, identity.dev);
      removeTree(control);
    });
    fs.mkdirSync(path.join(control, 'releases'), { mode: 0o755 });
    const releaseId = 'synthetic-artifact-verification';
    const release = path.join(control, 'releases', releaseId);
    fs.mkdirSync(release, { mode: 0o755 });
    const artifact = path.join(release, 'host-helper-artifact');
    fs.cpSync(process.env.DISPATCH_SYNTHETIC_ARTIFACT, artifact, { recursive: true, preserveTimestamps: false });
    const seal = directory => {
      for (const name of fs.readdirSync(directory)) {
        const child = path.join(directory, name);
        if (fs.lstatSync(child).isDirectory()) seal(child);
      }
      fs.chmodSync(directory, 0o555);
    };
    seal(artifact);
    fs.chmodSync(release, 0o555);
    const current = path.join(control, 'current');
    const manifest = fs.readFileSync(path.join(artifact, 'manifest.json'));
    const digest = crypto.createHash('sha256').update(manifest).digest('hex');
    const helper = path.join(artifact, 'core/installations/bin/dispatch-oci-host-helper');
    // The candidate must verify before it becomes current; active execution must not.
    assert.equal(verifyPreparedHostArtifact(helper, releaseId, digest).artifactRoot, artifact);
    assert.throws(() => verifyHostArtifact(helper, releaseId, digest));
    fs.symlinkSync(release, current);
    const check = () => verifyHostArtifact(helper, releaseId, digest);
    assert.equal(check().artifactRoot, artifact);
    const source = path.join(artifact, 'core/installations/src/oci-host-helper.js');
    const content = fs.readFileSync(source);
    fs.chmodSync(source, 0o644);
    assert.throws(check, { code: 'runtime_boundary_violation' });
    fs.writeFileSync(source, Buffer.concat([content, Buffer.from('\n// altered\n')]));
    fs.chmodSync(source, 0o444);
    assert.throws(() => verifyPreparedHostArtifact(helper, releaseId, digest), { code: 'runtime_boundary_violation' });
    assert.throws(check, { code: 'runtime_boundary_violation' });
    fs.chmodSync(source, 0o644); fs.writeFileSync(source, content); fs.chmodSync(source, 0o444);
    assert.equal(check().artifactRoot, artifact);
    fs.unlinkSync(current); fs.symlinkSync('/tmp', current);
    assert.throws(check, { code: 'runtime_boundary_violation' });
    fs.unlinkSync(current); fs.symlinkSync(release, current);
    fs.chmodSync(artifact, 0o755);
    assert.throws(check, { code: 'runtime_boundary_violation' });
    fs.chmodSync(artifact, 0o555);
    assert.equal(check().artifactRoot, artifact);

    // Exercise the real no-argument sudo command from a user with no other
    // sudo authorization. All state is synthetic and removed in finally.
    const caller = 'dispatch-helper-fixture';
    const issuerCaller = 'dispatch-issuer-fixture';
    const issuerRule = `/etc/sudoers.d/${issuerCaller}`;
    const issuerCommand = commandPlaceholder();
    function commandPlaceholder() { return '/opt/dispatch-control/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-issuer'; }
    const rule = `/etc/sudoers.d/${caller}`;
    const config = '/etc/dispatch/oci-host.json';
    const command = '/opt/dispatch-control/current/host-helper-artifact/core/installations/bin/dispatch-oci-host-helper';
    assert.equal(spawnSync('/usr/bin/getent', ['passwd', caller]).status, 2);
    assert.equal(spawnSync('/usr/bin/getent', ['group', caller]).status, 2);
    for (const file of [rule, config]) assert.throws(() => fs.lstatSync(file), { code: 'ENOENT' });
    const privateRoot = fs.mkdtempSync('/run/dispatch-helper-boundary-test-');
    const authorityRoot = path.join(privateRoot, 'authority');
    const stateRoot = path.join(privateRoot, 'state');
    fs.mkdirSync(authorityRoot, { mode: 0o700 }); fs.mkdirSync(stateRoot, { mode: 0o700 });
    let configParentCreated = false;
    let callerCreated = false;
    let issuerCreated = false;
    let ruleCreated = false;
    let configCreated = false;
    let authority;
    let recoveryUnit;
    try {
      try { fs.mkdirSync('/etc/dispatch', { mode: 0o755 }); configParentCreated = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const created = spawnSync('/usr/sbin/useradd', ['--system', '--user-group', '--no-create-home',
        '--shell', '/usr/sbin/nologin', caller], { encoding: 'utf8' });
      assert.equal(created.status, 0, created.stderr); callerCreated = true;
      assert.equal(spawnSync('/usr/bin/getent', ['passwd', issuerCaller]).status, 2);
      assert.equal(spawnSync('/usr/sbin/useradd', ['--system', '--user-group', '--no-create-home',
        '--shell', '/usr/sbin/nologin', issuerCaller]).status, 0);
      issuerCreated = true;
      const callerUid = Number(spawnSync('/usr/bin/id', ['-u', caller], { encoding: 'utf8' }).stdout.trim());
      const callerGid = Number(spawnSync('/usr/bin/id', ['-g', caller], { encoding: 'utf8' }).stdout.trim());
      const issuerUid = Number(spawnSync('/usr/bin/id', ['-u', issuerCaller], { encoding: 'utf8' }).stdout.trim());
      fs.writeFileSync(config, `${JSON.stringify({ stateRoot, authorityRoot, unitRoot: '/etc/systemd/system',
        releaseRoot: '/synthetic-unused-release-root', centralSocket: '/synthetic-unused-hub.sock',
        centralUid: 1001, controllerUid: 0, authorityUid: issuerUid, helperCallerUid: callerUid, helperCallerGid: callerGid, controlReleaseId: releaseId, helperManifestSha256: digest })}\n`,
      { flag: 'wx', mode: 0o600 });
      configCreated = true;
      const policy = `Defaults:${caller} env_reset,!setenv,secure_path="/usr/bin:/bin"\n`
        + `Defaults:${caller} env_delete += "NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH"\n`
        + `${caller} ALL=(root) NOPASSWD: NOSETENV: ${command} ""\n`;
      fs.writeFileSync(rule, policy, { flag: 'wx', mode: 0o440 }); ruleCreated = true;
      fs.writeFileSync(issuerRule, `Defaults:${issuerCaller} env_reset,!setenv,secure_path="/usr/bin:/bin"\n`
        + `Defaults:${issuerCaller} env_delete += "NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH"\n`
        + `${issuerCaller} ALL=(root) NOPASSWD: NOSETENV: ${issuerCommand} ""\n`, { flag: 'wx', mode: 0o440 });
      assert.equal(spawnSync('/usr/sbin/visudo', ['-cf', issuerRule]).status, 0);
      const checked = spawnSync('/usr/sbin/visudo', ['-cf', rule], { encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
      const invoke = (args, input, environment = []) => spawnSync('/usr/sbin/runuser', ['--user', caller,
        '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', ...environment, '/usr/bin/sudo', '-n', ...args],
      { input, encoding: 'utf8', timeout: 15_000 });
      assert.notEqual(invoke(['/usr/bin/true']).status, 0);
      assert.notEqual(invoke([command, '--arbitrary']).status, 0);
      authority = createOciHostAuthority({ root: authorityRoot });
      const lease = { version: 1, issuer: ISSUER, audience: AUDIENCE, organizationId: 'org_helper_fixture',
        runtimeKey: 'runtime_helper_fixture', installationRevision: 1, manifestRevisions: [1],
        backend: 'oci_container_v1', jobKind: 'provisioning', jobId: 'job_helper_fixture',
        workerId: 'worker_helper_fixture', generation: 1, fence: 1, expiresAt: Date.now() + 60_000 };
      authority.issueLease(lease);
      const request = { version: 2, operation: 'inspect_account', runtimeKey: lease.runtimeKey,
        claim: { jobId: lease.jobId, workerId: lease.workerId, generation: 1, fence: 1 } };
      const forged = invoke([command], `${JSON.stringify({ ...request, authorization: '0'.repeat(64) })}\n`);
      assert.notEqual(forged.status, 0);
      assert.deepEqual(fs.readdirSync(stateRoot), []);
      request.authorization = authority.issueAction(request);
      const accepted = invoke([command], `${JSON.stringify(request)}\n`, ['NODE_OPTIONS=--invalid-fixture-option']);
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
      assert.deepEqual(JSON.parse(accepted.stdout), { ok: true, result: null });
      const replay = invoke([command], `${JSON.stringify(request)}\n`);
      assert.notEqual(replay.status, 0);
      assert.notEqual(invoke([issuerCommand], '{}\n').status, 0);
      const invokeIssuer = (args, input) => spawnSync('/usr/sbin/runuser', ['--user', issuerCaller,
        '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/sudo', '-n', ...args],
      { input, encoding: 'utf8', timeout: 70_000 });
      assert.notEqual(invokeIssuer([command], '{}\n').status, 0);
      assert.notEqual(invokeIssuer(['/usr/bin/true']).status, 0);
      assert.notEqual(invokeIssuer([issuerCommand, '--extra'], '{}\n').status, 0);
      const { authorization, ...body } = request;
      const dispatched = invokeIssuer([issuerCommand], `${JSON.stringify({ version: 1, lease, request: body })}\n`);
      assert.equal(dispatched.status, 0, dispatched.stdout + dispatched.stderr);
      assert.deepEqual(JSON.parse(dispatched.stdout), { ok: true, result: null });
      assert.throws(() => authority.issueAction(body), { code: 'runtime_boundary_violation' });
      const again = invokeIssuer([issuerCommand], `${JSON.stringify({ version: 1, lease, request: body })}\n`);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.equal(fs.readdirSync(stateRoot).includes('candidates'), false);
      // A lost helper leaves its durable gate running while a process survives
      // in the exact supervised action unit. The issuer must stop it before it
      // can authorize another request for this runtime.
      authority.synchronizeLease(lease);
      const lost = { ...body, authorization: authority.issueAction(body) };
      recoveryUnit = `dispatch-host-action-${lost.authorization}.service`;
      const started = spawnSync('/usr/bin/systemd-run', ['--quiet', '--collect', `--unit=${recoveryUnit}`,
        `--property=User=${callerUid}`, `--property=Group=${callerGid}`, '--property=KillMode=control-group',
        '/usr/bin/sleep', '60'], { encoding: 'utf8' });
      assert.equal(started.status, 0, started.stderr);
      assert.throws(() => authority.execute(lost, () => { throw new Error('synthetic_interrupted_helper'); }), /synthetic_interrupted_helper/);
      assert.throws(() => authority.issueAction(body), /runtime_boundary_violation/);
      const recovered = invokeIssuer([issuerCommand], `${JSON.stringify({ version: 1, lease, request: body })}\n`);
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
      const observed = spawnSync('/usr/bin/systemctl', ['show', recoveryUnit, '--property=ActiveState,SubState,Job'], { encoding: 'utf8' });
      assert.match(observed.stdout, /ActiveState=inactive/);
      assert.match(observed.stdout, /SubState=dead/);
      assert.match(observed.stdout, /^Job=$/m);
      assert.throws(() => authority.issueAction(body), /runtime_boundary_violation/);

    } finally {
      if (recoveryUnit) spawnSync('/usr/bin/systemctl', ['stop', recoveryUnit]);
      authority?.close();
      if (fs.existsSync(issuerRule)) fs.unlinkSync(issuerRule);
      if (issuerCreated) {
        assert.equal(spawnSync('/usr/sbin/userdel', [issuerCaller]).status, 0);
        if (spawnSync('/usr/bin/getent', ['group', issuerCaller]).status === 0) {
          assert.equal(spawnSync('/usr/sbin/groupdel', [issuerCaller]).status, 0);
        }
      }
      if (ruleCreated) fs.unlinkSync(rule);
      if (configCreated) fs.unlinkSync(config);
      if (configParentCreated) fs.rmdirSync('/etc/dispatch');
      if (callerCreated) {
        const removed = spawnSync('/usr/sbin/userdel', [caller], { encoding: 'utf8' });
        assert.equal(removed.status, 0, removed.stderr);
        if (spawnSync('/usr/bin/getent', ['group', caller]).status === 0) {
          assert.equal(spawnSync('/usr/sbin/groupdel', [caller]).status, 0);
        }
      }
      fs.rmSync(privateRoot, { recursive: true });
      assert.equal(spawnSync('/usr/bin/getent', ['passwd', caller]).status, 2);
      assert.equal(spawnSync('/usr/bin/getent', ['group', caller]).status, 2);
    }
  });
}
