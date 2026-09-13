'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PRIVATE_DIRECTORY_MODE,
  INSTALLATION_SERVICE_PLAN_VERSION,
  INSTALLATION_AGENT_SERVICE_COUNT,
  createRuntimeAgentCredentialManager,
  createDurableInstallationProvisioner,
  createInstallationLayoutManager,
  createInstallationServiceManager,
  createSystemdUserSupervisor,
} = require('../src');
const { createManagedInstallationLifecycle } = require('../../../compatibility/provisioner/src/lifecycle.js');
const { AccessStore } = require('../../accounts/src/store');
const {
  createAccessInstallationLifecycleAuthority,
} = require('../../accounts/src/installation-lifecycle');
const { createRuntimeGatewayDispatchClient } = require('dispatch-dsp/runtime/gateway/src/index.js');

function manifest(id) {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: `org_${id}`, stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: {
      key: `fixture_${id}`,
      templateId: 'isolated_dsp_v1',
      releaseId: 'dispatch_fixture_1',
    },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

function inactiveState(plan) {
  return plan.units.map(unit => ({
    id: unit.id,
    name: unit.name,
    enabled: false,
    active: false,
    enableMode: 'none',
  }));
}

function rollback(serviceManager, supervisor, plan) {
  const state = serviceManager.rollbackState(plan);
  if (!state) return;
  supervisor.stop(plan, operation => operation());
  supervisor.resetFailed(plan, operation => operation());
  supervisor.disable(plan, operation => operation());
  serviceManager.restoreFiles(plan);
  supervisor.reload(plan, operation => operation());
  supervisor.restoreState(plan, state, operation => operation());
  serviceManager.finishRollback(plan);
}

function cleanupCommittedFixture(supervisor, plan) {
  supervisor.stop(plan, operation => operation());
  supervisor.resetFailed(plan, operation => operation());
  supervisor.disable(plan, operation => operation());
  for (const unit of [...plan.units].reverse()) {
    if (!fs.existsSync(unit.installed)) continue;
    const info = fs.lstatSync(unit.installed);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.uid, process.geteuid());
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o7777, 0o600);
    assert.equal(fs.realpathSync(unit.installed), unit.installed);
    assert.equal(fs.readFileSync(unit.installed, 'utf8'), unit.content);
    fs.unlinkSync(unit.installed);
  }
  supervisor.reload(plan, operation => operation());
  supervisor.resetFailed(plan, operation => operation());
  const stopped = supervisor.snapshot(plan);
  assert.equal(stopped.every(value => !value.enabled && !value.active), true);
}

function executeControl(plan, args) {
  const unit = plan.units.find(value => value.id === 'collection_manager');
  assert.ok(unit);
  const result = spawnSync(unit.healthCommand, args, {
    cwd: unit.workingDirectory,
    env: unit.environment,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error('fixture control returned invalid output'); }
  if (result.status !== 0 || result.signal !== null || value.ok !== true) {
    throw new Error(`fixture control failed: ${typeof value.status === 'string' ? value.status : 'unknown'}`);
  }
  return value;
}

async function verifyGateway(plan) {
  const unit = plan.units.find(value => value.id === 'runtime_gateway');
  assert.ok(unit);
  const client = createRuntimeGatewayDispatchClient({
    socketPath: unit.socketPath,
    runtimeKey: plan.runtimeKey,
  });
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.status, 'ready');
  const system = await client.system.status();
  assert.equal(system.ok, true);
  return system.status;
}

async function startSyntheticHub(socketPath, authorities) {
  const child = spawn(process.execPath, [
    path.join(__dirname, "../../agents/examples/synthetic-core-hub.js"),
  ], {
    env: {
      PATH: process.env.PATH,
      NODE_NO_WARNINGS: '1',
      DISPATCH_RUNTIME_AGENT_HUB_SOCKET: socketPath,
      DISPATCH_RUNTIME_AGENT_AUTHORITIES: JSON.stringify(authorities),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const queued = [];
  const waiting = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(line); else queued.push(line);
    }
  });
  child.once('exit', () => {
    while (waiting.length) waiting.shift().reject(new Error(stderr || 'runtime agent hub exited'));
  });
  const next = (timeoutMs = 15_000) => new Promise((resolve, reject) => {
    if (queued.length) return resolve(queued.shift());
    let timer;
    const pending = {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    };
    timer = setTimeout(() => {
      const index = waiting.indexOf(pending);
      if (index >= 0) waiting.splice(index, 1);
      reject(new Error('runtime agent hub timed out'));
    }, timeoutMs);
    waiting.push(pending);
  });
  const ready = JSON.parse(await next());
  assert.equal(ready.status, 'ready');
  return {
    async command(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
      return JSON.parse(await next());
    },
    async close() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    },
  };
}

function createFixtureLifecycleActivation(plan, supervisor) {
  const unit = plan.units.find(value => value.id === 'runtime_gateway');
  assert.ok(unit);
  const client = createRuntimeGatewayDispatchClient({
    socketPath: unit.socketPath,
    runtimeKey: plan.runtimeKey,
  });
  const current = async () => {
    const result = await client.sync.status('fixture-main-sync');
    assert.equal(result.status, 'found');
    return result.data;
  };
  return {
    inspectSchedule: async () => ({
      syncWasRunning: (await current()).desiredState === 'running',
    }),
    quiesceSchedule: async syncWasRunning => {
      if ((await current()).desiredState === 'running') {
        assert.equal(executeControl(plan, ['stop-sync', 'fixture-main-sync']).status, 'stopped');
      }
      const selected = await current();
      assert.equal(selected.desiredState, 'stopped');
      assert.equal(selected.activity, 'idle');
      assert.equal(selected.queuedRunCount, 0);
      assert.equal(selected.activeRun, null);
      return { syncWasRunning, changed: syncWasRunning };
    },
    restoreSchedule: async syncWasRunning => {
      const before = await current();
      if (syncWasRunning && before.desiredState === 'stopped') {
        assert.equal(executeControl(plan, ['start-sync', 'fixture-main-sync']).status, 'started');
      } else if (!syncWasRunning && before.desiredState === 'running') {
        assert.equal(executeControl(plan, ['stop-sync', 'fixture-main-sync']).status, 'stopped');
      }
      assert.equal((await current()).desiredState, syncWasRunning ? 'running' : 'stopped');
      return {
        syncWasRunning,
        changed: before.desiredState !== (syncWasRunning ? 'running' : 'stopped'),
      };
    },
    verifyInfrastructure: async () => supervisor.health(plan),
    verifyPublication: async () => { throw new Error('fixture_publication_not_available'); },
  };
}

async function executeFixtureWorker(plan) {
  const collector = path.resolve(__dirname, "../../collection-manager/tests/fixture-collector.js");
  const specPath = path.join(plan.candidateRoot, 'fixture-collection-spec.json');
  const syncSchema = {
    type: 'object',
    properties: {
      behavior: { type: 'string', enum: ['no_change'] },
      label: { type: 'string', maxLength: 64 },
    },
    required: ['behavior'],
    additionalProperties: false,
  };
  fs.writeFileSync(specPath, `${JSON.stringify({
    schemaVersion: 1,
    collectors: [{
      id: 'fixture',
      version: '1.0.0',
      description: 'Credential-free service fixture',
      command: collector,
      sourceSchema: {
        type: 'object',
        properties: { tenant: { type: 'string', maxLength: 64 } },
        required: ['tenant'],
        additionalProperties: false,
      },
      methods: {
        'fixture.sync': {
          description: 'Credential-free sync fixture',
          inputSchema: syncSchema,
          timeoutSeconds: 5,
          maxAttempts: 1,
          backoffSeconds: [],
          concurrencyKeys: ['collector:{collector}'],
        },
      },
    }],
    sources: [{
      id: 'fixture-main', collector: 'fixture', authProfile: null,
      config: { tenant: 'fixture' }, enabled: true,
    }],
    plans: [{
      id: 'fixture-sync-plan', source: 'fixture-main', method: 'fixture.sync',
      schedule: { type: 'manual' }, input: { behavior: 'no_change', label: 'fixture' },
      dependsOn: [], enabled: true,
    }],
    syncs: [{
      id: 'fixture-main-sync', plan: 'fixture-sync-plan', intervalSeconds: 60,
      jitterSeconds: 0, overlap: 'coalesce', settingsSchema: syncSchema,
      settings: { behavior: 'no_change', label: 'fixture' }, desiredState: 'stopped',
    }],
  })}\n`, { mode: 0o600 });
  assert.equal(executeControl(plan, ['apply', specPath]).status, 'applied');
  const waitForRun = runId => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = executeControl(plan, ['run-status', runId]);
      if (current.status === 'succeeded') {
        assert.equal(current.data.status, 'succeeded');
        return;
      }
      assert.ok(['queued', 'running'].includes(current.status));
      assert.ok(Date.now() < deadline);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  };
  const started = executeControl(plan, ['start-sync', 'fixture-main-sync']);
  assert.equal(started.status, 'started');
  waitForRun(started.data.run.id);

  const gatewayUnit = plan.units.find(unit => unit.id === 'runtime_gateway');
  const gateway = createRuntimeGatewayDispatchClient({
    socketPath: gatewayUnit.socketPath,
    runtimeKey: plan.runtimeKey,
  });
  assert.equal((await gateway.sync.status('fixture-main-sync')).status, 'found');
  const queued = await gateway.sync.runNow('fixture-main-sync', {
    idempotencyKey: `gateway:${crypto.randomBytes(12).toString('hex')}`,
  });
  assert.equal(queued.status, 'queued');
  waitForRun(queued.data.run.id);
  assert.equal((await gateway.sync.status('fixture-main-sync')).data.activity, 'idle');
  return 2;
}

async function main() {
const liveSystemd = process.env.DISPATCH_RUN_SYSTEMD_FIXTURE === '1';
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dm4-'));
fs.chmodSync(fixtureRoot, PRIVATE_DIRECTORY_MODE);
const isolatedRoot = path.join(fixtureRoot, 'isolated fixtures');
const installationsRoot = path.join(isolatedRoot, 'installations');
const offlineUnitRoot = path.join(isolatedRoot, 'units');
const controlRoot = path.join(isolatedRoot, 'control');
const accessRoot = path.join(isolatedRoot, 'access');
const centralRuntimeRoot = path.join(isolatedRoot, 'central-run');
fs.mkdirSync(isolatedRoot, { mode: PRIVATE_DIRECTORY_MODE });
fs.mkdirSync(installationsRoot, { mode: PRIVATE_DIRECTORY_MODE });
fs.mkdirSync(offlineUnitRoot, { mode: PRIVATE_DIRECTORY_MODE });
fs.mkdirSync(controlRoot, { mode: PRIVATE_DIRECTORY_MODE });
fs.mkdirSync(accessRoot, { mode: PRIVATE_DIRECTORY_MODE });
fs.mkdirSync(centralRuntimeRoot, { mode: PRIVATE_DIRECTORY_MODE });
const suffix = crypto.randomBytes(6).toString('hex');
const alpha = manifest(`a_${suffix}`);
const bravo = manifest(`b_${suffix}`);
const layoutManager = createInstallationLayoutManager({ installationsRoot });
let serviceManager = null;
let supervisor = null;
let alphaPlan = null;
let bravoPlan = null;
let provisioner = null;
let accessStore = null;
let alphaCommitted = false;
let workerExecutions = 0;
let backupRestoreExercised = false;
let runtimeAgentHubController = null;

try {
  const credentials = createRuntimeAgentCredentialManager({ installationsRoot });
  const alphaCredential = credentials.issue(alpha.runtime.key);
  const bravoCredential = credentials.issue(bravo.runtime.key);
  layoutManager.materialize(alpha, authority(alpha));
  layoutManager.materialize(bravo, authority(bravo));
  const runtimeAgentHubSocket = path.join(centralRuntimeRoot, 'runtime-agent-hub.sock');
  runtimeAgentHubController = await startSyntheticHub(runtimeAgentHubSocket, {
    [alpha.runtime.key]: alphaCredential.tokenHash,
    [bravo.runtime.key]: bravoCredential.tokenHash,
  });
  let unitRoot = offlineUnitRoot;
  if (liveSystemd) {
    if (typeof process.getuid !== 'function') throw new Error('systemd fixture requires a Unix uid');
    const systemdParent = `/run/user/${process.getuid()}/systemd`;
    const parent = fs.lstatSync(systemdParent);
    assert.equal(parent.isDirectory(), true);
    assert.equal(parent.isSymbolicLink(), false);
    assert.equal(parent.uid, process.geteuid());
    unitRoot = path.join(systemdParent, 'user');
    if (!fs.existsSync(unitRoot)) fs.mkdirSync(unitRoot, { mode: PRIVATE_DIRECTORY_MODE });
  }
  serviceManager = createInstallationServiceManager({ unitRoot, runtimeAgentHubSocket });
  alphaPlan = serviceManager.plan(alpha, authority(alpha), layoutManager.derive(alpha, authority(alpha)));
  bravoPlan = serviceManager.plan(bravo, authority(bravo), layoutManager.derive(bravo, authority(bravo)));
  if (liveSystemd) {
    serviceManager.render(bravoPlan);
    serviceManager.validate(bravoPlan);
  } else {
    serviceManager.render(alphaPlan);
    serviceManager.render(bravoPlan);
    serviceManager.validate(alphaPlan);
    serviceManager.validate(bravoPlan);
  }
  assert.equal(alphaPlan.units.some(unit => bravoPlan.units.some(other => other.name === unit.name)), false);

  if (!liveSystemd) {
    serviceManager.install(alphaPlan, inactiveState(alphaPlan));
    serviceManager.restoreFiles(alphaPlan);
    serviceManager.finishRollback(alphaPlan);
  } else {
    supervisor = createSystemdUserSupervisor({ runtimeOnly: true });
    provisioner = createDurableInstallationProvisioner({
      stateRoot: controlRoot,
      installationsRoot,
      unitRoot,
      supervisor,
      systemdRuntimeOnly: true,
      idFactory: () => `job_fixture_service_${suffix}`,
      runtimeAgentHubSocket,
    });
    const fixtureRegistration = {
      fixture: true, installationState: 'pending', retainedData: false,
    };
    const manage = {
      scope: 'operator_fixture',
      permission: 'platform.installations.manage',
      operatorEnabled: true,
    };
    provisioner.registerFixture(alpha, authority(alpha), fixtureRegistration);
    provisioner.request(alpha, authority(alpha), {
      operation: 'provision',
      idempotencyKey: `systemd_fixture_${suffix}`,
      expectedRevision: 1,
    }, manage);
    const completed = provisioner.runNext(`worker_fixture_${suffix}`);
    if (completed.status !== 'succeeded') {
      const progress = provisioner.progress(
        alpha,
        authority(alpha),
        { scope: 'operator_fixture', permission: 'platform.installations.read' },
        completed.id,
      );
      throw new Error(`durable service fixture failed: ${completed.failure?.code || 'unknown'}:${progress.completedStages}`);
    }
    assert.equal(completed.installationState, 'provisioning');
    alphaCommitted = true;
    supervisor.health(alphaPlan);

    serviceManager.install(bravoPlan, supervisor.snapshot(bravoPlan));
    supervisor.reload(bravoPlan, operation => operation());
    supervisor.enable(bravoPlan, operation => operation());
    supervisor.start(bravoPlan, operation => operation());
    supervisor.health(bravoPlan);
    const gatewayStatuses = await Promise.all([verifyGateway(alphaPlan), verifyGateway(bravoPlan)]);
    assert.equal(gatewayStatuses.every(status => ['ready', 'degraded'].includes(status)), true);
    const crossedGateway = createRuntimeGatewayDispatchClient({
      socketPath: bravoPlan.units.find(unit => unit.id === 'runtime_gateway').socketPath,
      runtimeKey: alphaPlan.runtimeKey,
    });
    assert.equal((await crossedGateway.system.status()).status, 'runtime_identity_mismatch');
    const agentStatuses = [];
    for (const plan of [alphaPlan, bravoPlan]) {
      agentStatuses.push(await runtimeAgentHubController.command({
        action: 'system.status', runtimeKey: plan.runtimeKey,
      }));
    }
    assert.equal(agentStatuses.every(result => result.ok), true);
    workerExecutions += await executeFixtureWorker(alphaPlan);

    accessStore = new AccessStore({
      databaseRoot: accessRoot,
      database: path.join(accessRoot, 'access-control.sqlite3'),
    });
    accessStore.transaction(() => {
      accessStore.createOrganization({
        id: alpha.organization.id,
        name: 'Lifecycle service fixture',
        abbreviation: 'LSF',
        timezone: alpha.organization.timezone,
        status: 'active',
        createdBy: null,
        timestamp: Date.now(),
      });
      accessStore.insertStation(alpha.organization.id, alpha.organization.stationCode, true, Date.now());
      accessStore.createInstallation(
        alpha.organization.id, alpha.runtime.key, 'ready', Date.now(), alpha.runtime.releaseId,
      );
    });
    let lifecycleIds = 0;
    const lifecycleAuthority = createAccessInstallationLifecycleAuthority({
      store: accessStore,
      organizationId: alpha.organization.id,
      authorityScope: 'systemd_fixture_lifecycle',
      jobFactory: () => `life_fixture_${suffix}_${++lifecycleIds}`,
      backupFactory: () => `backup_fixture_${suffix}_${++lifecycleIds}`,
    });
    const lifecycle = createManagedInstallationLifecycle({
      authority: lifecycleAuthority,
      installationsRoot,
      unitRoot,
      supervisor,
      projectRoot: path.resolve(__dirname, "../../.."),
      projectReleaseId: alpha.runtime.releaseId,
      activationRuntimeFactory: () => createFixtureLifecycleActivation(alphaPlan, supervisor),
      runtimeAgentHubSocket,
    });
    const alphaLayout = layoutManager.derive(alpha, authority(alpha));
    const marker = path.join(alphaLayout.directories.providerDataRoot, 'lifecycle-fixture.txt');
    fs.writeFileSync(marker, 'before-restore\n', { mode: 0o600 });
    let control = accessStore.installationControl(alpha.organization.id);
    const backupJob = lifecycleAuthority.request({
      operation: 'backup',
      idempotencyKey: `systemd:lifecycle:backup:${suffix}`,
      expectedRevision: control.revision,
    });
    const backupResult = await lifecycle.run(backupJob.id, `life_worker_backup_${suffix}`);
    assert.equal(backupResult.status, 'succeeded', JSON.stringify({
      result: backupResult,
      job: lifecycleAuthority.inspect(backupJob.id),
    }));
    supervisor.health(alphaPlan);
    const sourceBackup = lifecycleAuthority.backups()[0];
    assert.ok(sourceBackup);

    control = accessStore.installationControl(alpha.organization.id);
    const suspendJob = lifecycleAuthority.request({
      operation: 'suspend',
      idempotencyKey: `systemd:lifecycle:suspend:${suffix}`,
      expectedRevision: control.revision,
    });
    assert.equal((await lifecycle.run(suspendJob.id, `life_worker_suspend_${suffix}`)).status, 'succeeded');
    assert.equal(supervisor.snapshot(alphaPlan).every(value => !value.active), true);
    fs.writeFileSync(marker, 'after-backup\n', { mode: 0o600 });

    control = accessStore.installationControl(alpha.organization.id);
    const restoreJob = lifecycleAuthority.request({
      operation: 'restore',
      idempotencyKey: `systemd:lifecycle:restore:${suffix}`,
      expectedRevision: control.revision,
      backupId: sourceBackup.id,
    });
    assert.equal((await lifecycle.run(restoreJob.id, `life_worker_restore_${suffix}`)).status, 'succeeded');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'before-restore\n');
    assert.equal(supervisor.snapshot(alphaPlan).every(value => !value.active), true);
    backupRestoreExercised = true;
    supervisor.start(alphaPlan, operation => operation());
    supervisor.health(alphaPlan);

    supervisor.restartEvidence(alphaPlan, 'auth_broker', operation => operation());
    supervisor.restartEvidence(alphaPlan, 'runtime_agent', operation => operation());
    supervisor.restartEvidence(bravoPlan, 'collection_manager', operation => operation());
    workerExecutions += await executeFixtureWorker(bravoPlan);
    supervisor.boundedRestartEvidence(bravoPlan, 'collection_manager', operation => operation());

    rollback(serviceManager, supervisor, bravoPlan);
    supervisor.health(alphaPlan);
    serviceManager.finalizeSettled(alphaPlan);
    cleanupCommittedFixture(supervisor, alphaPlan);
    alphaCommitted = false;
    assert.equal(fs.existsSync(alphaPlan.journal), false);
    assert.equal(fs.existsSync(bravoPlan.journal), false);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'verified',
    servicePlanVersion: INSTALLATION_SERVICE_PLAN_VERSION,
    fixtures: 2,
    servicesPerFixture: liveSystemd ? INSTALLATION_AGENT_SERVICE_COUNT : alphaPlan.units.length,
    isolated: true,
    systemdValidated: true,
    lifecycle: liveSystemd ? 'exercised' : 'offline',
    restartRecovery: liveSystemd,
    restartBounded: liveSystemd,
    workerExecutions,
    durablePipeline: liveSystemd,
    gatewayRouting: liveSystemd,
    crossRouteRejected: liveSystemd,
    rollback: liveSystemd ? 'verified' : 'file_transaction_verified',
    backupRestore: backupRestoreExercised ? 'verified' : 'offline',
  })}\n`);
} finally {
  try { accessStore?.close(); } catch {}
  try { provisioner?.close(); } catch {}
  try { await runtimeAgentHubController?.close(); } catch {}
  if (supervisor && serviceManager) {
    for (const plan of [bravoPlan, alphaPlan]) {
      if (!plan) continue;
      try { rollback(serviceManager, supervisor, plan); } catch {}
    }
    if (alphaCommitted && alphaPlan) {
      try { cleanupCommittedFixture(supervisor, alphaPlan); } catch {}
    }
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
}

main().catch(() => {
  process.stderr.write('installation service fixture failed\n');
  process.exitCode = 1;
});
