'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { publicRootJson } = require('../../src/offsite-policy');
const { privateJson, atomic } = require('../../src/release-delivery-files');
const { createPlan } = require('../../src/native-deployment');
const PROJECT = path.resolve(__dirname, "../../../..");
const ROOT = '/var/lib/dispatch-live-tests';
function validateTarget(state, target, row, allowIncomplete = false) {
  assert.match(state.id, /^live_[a-f0-9]{32}$/);
  assert.ok(state.targets.includes(target));
  assert.match(target.organizationId, /^org_[a-f0-9]{32}$/);
  assert.equal(row.organization_id, target.organizationId);
  assert.equal(row.backend, 'native_service_v1');
  assert.equal(row.owner_email, target.email);
  assert.equal(target.email, `${state.id}-${target.index}@dispatch-test.invalid`);
  assert.ok(row.name === `TEST ${state.id.slice(5, 13)} DSP ${target.index + 1}` || allowIncomplete && !target.profileApplied && row.name === 'New DSP');
}
function requestApi(config, session, endpoint, body) {
  return new Promise((resolve, reject) => {
    const request = require('node:http').request({ hostname: '127.0.0.1', port: config.port, path: endpoint,
      method: body === undefined ? 'GET' : 'POST', timeout: 30000,
      headers: { Host: new URL(config.publicOrigin).host, Origin: config.publicOrigin, 'CF-Visitor': '{"scheme":"https"}',
        ...(session ? { Cookie: `__Host-dispatch_session=${session.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Dispatch-CSRF': session?.csrf || '' }) },
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) request.destroy(Error('test_response_too_large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try {
        const value = JSON.parse(Buffer.concat(chunks));
        resolve({ status: response.statusCode, value, token: response.headers['set-cookie']?.[0]?.split(';')[0]?.split('=')[1] });
      } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(Error('test_request_timeout'))); request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function main(argv) {
  assert.equal(process.geteuid(), 0, 'Run as the server administrator with sudo');
  assert.ok(['run', 'cleanup', 'status'].includes(argv[0]));
  assert.equal(argv.length, argv[0] === 'run' ? 1 : 2);
  process.umask(0o077);
  const config = privateJson('/etc/dispatch/release-delivery.json', 0);
  const source = path.join(config.localRoot, 'data/access-control/access-control.sqlite3');
  const read = fn => { const db = new DatabaseSync(source, { readOnly: true }); try { return fn(db); } finally { db.close(); } };
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(ROOT), ROOT);
  const stat = fs.statSync(ROOT); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o077, 0);
  const id = argv[0] === 'run' ? 'live_' + crypto.randomBytes(16).toString('hex') : argv[1];
  assert.match(id, /^live_[a-f0-9]{32}$/);
  const directory = path.join(ROOT, id), file = path.join(directory, 'state.json');
  if (argv[0] === 'run') fs.mkdirSync(directory, { mode: 0o700 });
  let state = argv[0] === 'run' ? { schemaVersion: 1, id, status: 'running', targets: [], cases: [], boundaries: {
    provider: 'Synthetic publication records; provider collection remains stopped',
    email: 'Private invitation registration; no email sent',
    backup: 'Live encrypted backup worker and R2 storage',
  } } : privateJson(file, 0);
  const save = () => { atomic(file, state); atomic(path.join(directory, 'report.json'), { schemaVersion: 1, id, status: state.status, cases: state.cases, boundaries: state.boundaries, targets: state.targets.map(t => ({ organizationId: t.organizationId, name: t.name, deleted: t.deleted || false })) }); };
  if (argv[0] === 'status') { console.log(JSON.stringify(privateJson(path.join(directory, 'report.json'), 0))); return; }
  const lock = path.join(ROOT, 'active.lock');
  if (fs.existsSync(lock)) {
    const previous = privateJson(lock, 0); assert.ok(Number.isSafeInteger(previous.pid) && previous.pid > 1);
    try { process.kill(previous.pid, 0); throw Error('live_test_already_running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, JSON.stringify({ pid: process.pid, id })); fs.closeSync(fd);
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const active = () => { if (interrupted) throw Error('test_interrupted'); };
  const invoke = (script, data) => JSON.parse(execFileSync('/usr/bin/node', ['--no-warnings', path.join(__dirname, script)], {
    uid: config.uid, gid: config.gid, input: JSON.stringify({ ...data, localRoot: config.localRoot }), encoding: 'utf8', timeout: 120000,
    env: { PATH: '/usr/bin:/bin', HOME: execFileSync('/usr/bin/getent', ['passwd', String(config.uid)], { encoding: 'utf8' }).trim().split(':')[5], DISPATCH_LOCAL_ROOT: config.localRoot },
  }));
  async function api(session, endpoint, body, expected = 200) {
    active();
    const result = await requestApi(config, session, endpoint, body);
    assert.equal(result.status, expected, `${endpoint}: ${result.value.error?.code || result.value.status}`);
    return result;
  }
  async function until(fn, timeout = 3600000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      active(); const value = await fn(); if (value) return value;
      // Exercise the browser's read paths while host operations hold fences.
      const session = await api(state.platform, '/api/auth/session');
      assert.equal(session.value.data.authenticated, true, 'Platform session must remain available during DSP operations');
      await api(state.platform, '/api/platform/organizations');
      await new Promise(r => setTimeout(r, 2000));
    }
    throw Error('test_operation_timeout');
  }
  async function check(name, action) {
    active(); console.log('START ' + name); const started = Date.now();
    try { await action(); state.cases.push({ name, status: 'passed', durationMs: Date.now() - started }); console.log('PASS ' + name); }
    catch (e) { state.cases.push({ name, status: 'failed', code: e.code === 'ERR_ASSERTION' ? e.message : e.code || e.message }); throw e; }
    finally { save(); }
  }
  const rowFor = target => read(db => db.prepare(`SELECT i.*,o.name,p.owner_email,s.code station,o.timezone FROM installations i JOIN organizations o ON o.id=i.organization_id
    JOIN organization_profiles p ON p.organization_id=o.id JOIN stations s ON s.organization_id=o.id AND s.is_primary=1 WHERE o.id=?`).get(target.organizationId));
  const owned = target => { const row = rowFor(target); validateTarget(state, target, row); return row; };
  const controls = async (target, allowIncomplete = false) => {
    const current = rowFor(target); validateTarget(state, target, current, allowIncomplete);
    const rows = (await api(state.platform, '/api/platform/organizations')).value.data;
    const matches = rows.filter(r => r.name === current.name && r.ownerEmail === target.email);
    assert.equal(matches.length, 1); return matches[0];
  };
  async function settleStatus(target, operation, startingRevision, expectedStatus) {
    await until(() => read(db => {
      const job = db.prepare(`SELECT status,failure_code FROM installation_lifecycle_jobs
        WHERE organization_id=? AND operation=? AND installation_revision>?
        ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(target.organizationId, operation, startingRevision);
      assert.notEqual(job?.status, 'failed', `${operation} lifecycle failed: ${job?.failure_code}`);
      return job?.status === 'succeeded' && owned(target).status === expectedStatus;
    }), 300000);
  }
  async function drain() {
    await until(() => read(db => {
      const rows = db.prepare("SELECT status,failure_code FROM platform_backup_requests WHERE idempotency_key LIKE ?").all(`${id}:%`);
      assert.ok(!rows.some(r => r.status === 'failed'), JSON.stringify(rows));
      return rows.length && rows.every(r => r.status === 'completed');
    }));
  }
  function planFor(target) {
    const row = owned(target), registry = new DatabaseSync('/var/lib/dispatch-host/state/oci-host.sqlite3', { readOnly: true });
    let allocation; try { allocation = registry.prepare('SELECT * FROM allocations WHERE runtime_key=?').get(row.runtime_key); } finally { registry.close(); }
    assert.ok(allocation); assert.equal(allocation.account_name.startsWith('dsp-'), true);
    const release = JSON.parse(fs.readFileSync(path.join(config.localRoot, 'config/oci-releases.json'))).releases[row.release_id];
    const manifest = { manifestVersion: 1, revision: row.manifest_revision, organization: { id: row.organization_id, stationCode: row.station, timezone: row.timezone }, runtime: { key: row.runtime_key, templateId: 'isolated_dsp_v1', releaseId: row.release_id } };
    return createPlan(manifest, { revision: manifest.revision, organization: manifest.organization, runtime: manifest.runtime }, release,
      { name: allocation.account_name, uid: allocation.uid, gid: allocation.gid, subuidStart: allocation.subuid_start, subgidStart: allocation.subgid_start, subidCount: 65536 },
      { version: 1, backend: 'native_service_v1', channel: 'production', organizationId: row.organization_id, runtimeKey: row.runtime_key, manifestRevision: row.manifest_revision, releaseId: row.release_id });
  }
  const systemState = unit => execFileSync('/usr/bin/systemctl', ['show', unit, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
  function marker(target, content) {
    const plan = planFor(target), markerFile = path.join(plan.host.installationRoot, 'data/live-test-marker');
    if (content === undefined) return execFileSync('/usr/sbin/runuser', ['--user', plan.account.name, '--', '/usr/bin/cat', '--', markerFile], { encoding: 'utf8' });
    execFileSync('/usr/sbin/runuser', ['--user', plan.account.name, '--', '/usr/bin/python3', '-c',
      'import os,sys; f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600); os.write(f,sys.stdin.buffer.read()); os.close(f)', markerFile], { input: content });
  }
  async function cleanup() {
    for (const target of state.targets) {
      if (!rowFor(target)) { target.deleted = true; save(); continue; }
      let row = await controls(target, true);
      const allocation = target.account;
      if (row.installation.state !== 'decommissioned' && row.installation.operation?.kind !== 'destroy') {
        await api(state.platform, '/api/platform/installation/remove', { controlRef: row.controlRef, expectedRevision: row.installation.revision,
          idempotencyKey: `${id}:remove:${target.index}` }, 202);
        await until(() => rowFor(target)?.status === 'decommissioned');
        row = await controls(target, true);
      }
      invoke('operator.js', { action: 'destroy', session: state.platform, runId: id, index: target.index,
        organizationId: target.organizationId, expectedRevision: row.installation.revision });
      await until(() => !rowFor(target)); target.deleted = true; save();
      if (target.backupId) {
        const proof = privateJson(`/var/lib/dispatch-backup/archives/${target.backupId}.json`, 0);
        assert.equal(proof.status, 'destroyed'); assert.ok(proof.deletedAt);
      }
      if (target.session) await api(target.session, '/api/paycom/daily?date=2026-09-05', undefined, 401);
      if (allocation) {
        assert.throws(() => execFileSync('/usr/bin/id', [allocation], { stdio: 'pipe' }));
        assert.equal(fs.existsSync(target.hostRoot), false);
      }
    }
  }
  try {
    await check('verify installed native release', async () => {
      const health = (await api(null, '/api/platform/core-health')).value;
      assert.equal(health.ok, true);
      const command = execFileSync('/usr/bin/systemctl', ['--user', 'show', 'dispatch-dashboard.service', '--property=ExecStart', '--value'], {
        uid: config.uid, gid: config.gid, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: `/run/user/${config.uid}` },
      });
      assert.match(command, /--installation-backend native_service_v1/, 'Live Core must use the native backend');
      const commit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: PROJECT, uid: config.uid, gid: config.gid, encoding: 'utf8' }).trim();
      assert.equal(health.data.sourceCommit, commit, 'Run the tool from the deployed source commit');
    });
    state.platform = invoke('operator.js', { action: 'session' }); save();
    if (argv[0] === 'cleanup') { await check('delete recorded test DSPs', cleanup); state.status = 'cleaned'; save(); return; }
    await check('live native preflight', async () => {
      assert.equal(read(db => !!db.prepare("SELECT 1 FROM platform_rollouts WHERE status!='completed'").get()), false, 'Finish the rollout first');
      const backupStatus = publicRootJson('/var/lib/dispatch-backup-receipts/catalog.json', false, 0, 1024 * 1024);
      assert.ok(backupStatus.backups);
      const policy = require('../../src/offsite-policy');
      assert.equal(policy.offsiteRequired(), true, 'Verified offsite protection must be enabled'); policy.assertOffsiteReady();
      for (const name of fs.readdirSync('/var/lib/dispatch-backup/archives')) {
        if (!/^(backup|breq)_[a-f0-9]{32}\.json$/.test(name)) continue;
        const proof = privateJson('/var/lib/dispatch-backup/archives/' + name, 0);
        if (proof.kind === 'core' && !proof.deletedAt) assert.equal(proof.organizationInventoryVersion, 1, 'Existing Core backup needs a complete inventory before test deletion');
      }
      for (const name of fs.readdirSync('/var/lib/dispatch-backup-receipts')) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const proof = publicRootJson('/var/lib/dispatch-backup-receipts/' + name, false, 0, 1024 * 1024);
        if (Array.isArray(proof.organizationIds)) assert.equal(proof.organizationInventoryVersion, 1, 'Existing Core snapshot needs a complete inventory before test deletion');
      }
      state.baselineArchives = Object.entries(backupStatus.backups).filter(([, proof]) => proof.status === 'verified').map(([id]) => id);
      const backupSettings = read(db => db.prepare('SELECT settings_json FROM platform_backup_settings WHERE id=1').get());
      assert.ok(!backupSettings || !JSON.parse(backupSettings.settings_json).enabled, 'Disable automatic fleet backups for the test window; the runner does not change shared settings');
      state.baseline = read(db => db.prepare("SELECT organization_id,runtime_key,release_id,status FROM installations WHERE status!='decommissioned' ORDER BY organization_id").all());
    });
    await check('create and register two native test DSPs', async () => {
      for (let index = 0; index < 2; index++) {
        const created = invoke('operator.js', { action: 'create', session: state.platform, runId: id, index });
        const target = { ...created, index, name: `TEST ${id.slice(5, 13)} DSP ${index + 1}`, password: crypto.randomBytes(24).toString('base64url') };
        state.targets.push(target); save();
        const result = await api(null, '/api/auth/register', { token: target.invitationToken, firstName: 'Synthetic', lastName: 'Test Owner', password: target.password, confirmPassword: target.password }, 201);
        target.session = { token: result.token, csrf: result.value.data.csrfToken }; delete target.invitationToken; save();
        await api(target.session, '/api/organization/profile', { name: target.name, abbreviation: `T${index + 1}`, stationCode: 'TST1', timezone: 'UTC' });
        target.profileSubmitted = true; save();
        await until(() => { const row = rowFor(target); assert.notEqual(row?.status, 'failed'); return row?.name === target.name && row.status === 'ready'; }, 300000);
        target.profileApplied = true;
        const plan = planFor(target); target.account = plan.account.name; target.hostRoot = path.dirname(path.dirname(plan.host.installationRoot)); save();
        assert.equal(systemState(plan.identity.unitName), 'active');
      }
      assert.notEqual(state.targets[0].account, state.targets[1].account);
    });
    await check('seed only recorded DSPs with synthetic publication data', async () => {
      const tools = path.join(directory, 'tools'); fs.mkdirSync(tools, { mode: 0o755 }); fs.chmodSync(tools, 0o755);
      fs.writeFileSync(path.join(tools, 'helpers.js'), fs.readFileSync(path.join(PROJECT, 'plugins/paycom/backend/tests/helpers.js'), 'utf8').replace("require('../src/timecard-period')", "require('/opt/dispatch/plugins/paycom/backend/src/timecard-period')"), { mode: 0o444 });
      fs.chmodSync(path.join(tools, 'helpers.js'), 0o444);
      fs.copyFileSync(path.join(__dirname, "./seed.js"), path.join(tools, 'seed.js')); fs.chmodSync(path.join(tools, 'seed.js'), 0o444);
      for (const target of state.targets) {
        const plan = planFor(target), artifact = `/opt/dispatch-runtime/releases/${plan.release.releaseId}/runtime-artifact`;
        const properties = { User: plan.account.name, Group: plan.account.name, ProtectSystem: 'strict', ProtectHome: 'true', PrivateTmp: 'true', PrivateNetwork: 'true', NoNewPrivileges: 'true',
          BindReadOnlyPaths: `${artifact}:/opt/dispatch ${tools}:/run/dispatch-test-tools`, BindPaths: plan.host.installationRoot + ':' + plan.guest.installationRoot, WorkingDirectory: '/opt/dispatch', UMask: '0077' };
        const seed = JSON.parse(execFileSync('/usr/bin/systemd-run', ['--quiet', '--wait', '--pipe', '--collect', '--unit=dispatch-live-seed-' + crypto.randomBytes(8).toString('hex'),
          ...Object.entries(properties).flatMap(([k, v]) => ['--property', `${k}=${v}`]),
          ...Object.entries({ ...plan.guest.environment, PATH: '/opt/dispatch/dependencies/node/bin:/usr/bin:/bin' }).flatMap(([k, v]) => ['--setenv', `${k}=${v}`]),
          artifact + '/dependencies/node/bin/node', '--no-warnings', '/run/dispatch-test-tools/seed.js'], { encoding: 'utf8', timeout: 120000 }));
        invoke('activate.js', { organizationId: target.organizationId, seed });
        marker(target, `${id}:${target.index}:before`);
      }
    });
    await check('back up both DSPs through the live encrypted backup worker', async () => {
      const body = { action: 'backup', scope: 'dsps', organizationIds: state.targets.map(t => owned(t).organization_id), idempotencyKey: `${id}:backup` };
      await api(state.platform, '/api/platform/backups', body); await api(state.platform, '/api/platform/backups', body); await drain();
      for (const target of state.targets) {
        target.backupId = read(db => db.prepare("SELECT id FROM platform_backup_records WHERE organization_id=? AND kind='dsp' ORDER BY created_at DESC LIMIT 1").get(target.organizationId)).id;
        const proof = privateJson(`/var/lib/dispatch-backup/archives/${target.backupId}.json`, 0);
        assert.equal(proof.status, 'verified'); assert.match(proof.recoveryDigest, /^[a-f0-9]{64}$/); save();
      }
    });
    const target = state.targets[0], peer = state.targets[1];
    await check('suspend only the target DSP and deny its existing session', async () => {
      const control = await controls(target);
      await api(state.platform, '/api/platform/organization/status', { controlRef: control.controlRef, suspended: true, idempotencyKey: `${id}:suspend` });
      await settleStatus(target, 'suspend', control.installation.revision, 'suspended');
      assert.equal(systemState(planFor(target).identity.unitName), 'inactive');
      await api(target.session, '/api/paycom/daily?date=2026-09-05', undefined, 401);
      assert.equal(systemState(planFor(peer).identity.unitName), 'active');
    });
    await check('restore backed-up data while keeping the DSP suspended', async () => {
      await api(state.platform, '/api/platform/backups', { action: 'restore', organizationId: peer.organizationId, backupId: target.backupId, confirmation: peer.name, idempotencyKey: `${id}:wrong-restore` }, 409);
      marker(target, 'changed after backup');
      await api(state.platform, '/api/platform/backups', { action: 'restore', organizationId: target.organizationId, backupId: target.backupId, confirmation: target.name, idempotencyKey: `${id}:restore` });
      await drain(); assert.equal(marker(target), `${id}:0:before`); assert.equal(marker(peer), `${id}:1:before`);
      assert.equal(owned(target).status, 'suspended'); assert.equal(systemState(planFor(target).identity.unitName), 'inactive');
    });
    await check('resume the restored DSP', async () => {
      const control = await controls(target);
      await api(state.platform, '/api/platform/organization/status', { controlRef: control.controlRef, suspended: false, idempotencyKey: `${id}:resume` });
      await settleStatus(target, 'resume', control.installation.revision, 'ready');
      assert.equal(systemState(planFor(target).identity.unitName), 'active');
      const result = await api(null, '/api/auth/login', { email: target.email, password: target.password });
      target.session = { token: result.token, csrf: result.value.data.csrfToken }; save();
      await api(target.session, '/api/paycom/daily?date=2026-09-05');
    });
    await check('delete test DSPs and verify account and data removal', cleanup);
    await check('preserve pre-existing DSP installations', async () => {
      const current = read(db => db.prepare("SELECT organization_id,runtime_key,release_id,status FROM installations WHERE status!='decommissioned' ORDER BY organization_id").all());
      assert.deepEqual(current, state.baseline);
      await until(() => {
        const catalog = publicRootJson('/var/lib/dispatch-backup-receipts/catalog.json', false, 0, 1024 * 1024);
        return state.baselineArchives.every(id => catalog.backups[id]?.status === 'verified');
      }, 120000);
    });
    state.status = 'passed'; save();
  } catch (e) { state.status = 'failed'; save(); throw e; }
  finally {
    if (state.platform) { try { invoke('operator.js', { action: 'logout', session: state.platform }); } catch {} delete state.platform; save(); }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    fs.unlinkSync(lock);
    console.log(`Report: ${directory}/report.json`);
    if (state.targets.some(t => !t.deleted)) console.log(`Cleanup: sudo ${PROJECT}/core/installations/scripts/verify-live-dsps cleanup ${id}`);
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.code === 'ERR_ASSERTION' ? e.message : e.code || e.message); process.exitCode = 1; });
module.exports = { main, validateTarget, requestApi };
