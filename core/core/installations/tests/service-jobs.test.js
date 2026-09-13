'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const {
  INSTALLATION_LAYOUT_TEMPLATE,
  PRIVATE_DIRECTORY_MODE,
  INSTALLATION_SERVICE_PLAN_VERSION,
  INSTALLATION_AGENT_SERVICE_COUNT,
  createInstallationLayoutManager,
  createInstallationServiceManager,
  createDurableInstallationProvisioner,
} = require('../src');
const {
  INSTALLATION_SERVICE_PIPELINE_ID,
  INSTALLATION_ROLLBACK_MAX_ATTEMPTS,
  createInstallationJobStore,
} = require('../src/job-store');

const MANAGE = Object.freeze({
  scope: 'operator_fixture',
  permission: 'platform.installations.manage',
  operatorEnabled: true,
});
const READ = Object.freeze({ scope: 'operator_fixture', permission: 'platform.installations.read' });
const FIXTURE_REGISTRATION = Object.freeze({
  fixture: true,
  installationState: 'pending',
  retainedData: false,
});

function manifest(id) {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: `org_${id}`, stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: {
      key: `fixture_${id}`,
      templateId: INSTALLATION_LAYOUT_TEMPLATE,
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

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dj4-'));
  fs.chmodSync(root, PRIVATE_DIRECTORY_MODE);
  const stateRoot = path.join(root, 'c');
  const installationsRoot = path.join(root, 'i');
  const unitRoot = path.join(root, 'u');
  for (const selected of [stateRoot, installationsRoot, unitRoot]) {
    fs.mkdirSync(selected, { mode: PRIVATE_DIRECTORY_MODE });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateRoot, installationsRoot, unitRoot };
}

function serviceReceipt(status, changed = false) {
  return Object.freeze({
    servicePlanVersion: INSTALLATION_SERVICE_PLAN_VERSION,
    status,
    serviceCount: INSTALLATION_AGENT_SERVICE_COUNT,
    changed,
  });
}

function fakeSupervisor(options = {}) {
  const states = new Map();
  const actions = [];
  let failStart = Boolean(options.failStart);
  let failHealth = Boolean(options.failHealth);
  let afterStart = null;

  function state(unit) {
    if (!states.has(unit.name)) {
      states.set(unit.name, { enabled: false, active: false, enableMode: 'none' });
    }
    return states.get(unit.name);
  }

  function mutate(capability, action, operation) {
    capability(() => {
      actions.push(action);
      operation();
    });
  }

  const api = {
    states,
    actions,
    setFailStart(value) { failStart = value; },
    setFailHealth(value) { failHealth = value; },
    setAfterStart(callback) { afterStart = callback; },
    snapshot(plan) {
      return plan.units.map(unit => ({ id: unit.id, name: unit.name, ...state(unit) }));
    },
    reload(_plan, capability) {
      mutate(capability, 'reload', () => {});
      return serviceReceipt('reloaded', true);
    },
    enable(plan, capability) {
      for (const unit of plan.units) {
        mutate(capability, `enable:${unit.id}`, () => {
          state(unit).enabled = true;
          state(unit).enableMode = 'runtime';
        });
      }
      return serviceReceipt('enabled', true);
    },
    disable(plan, capability) {
      for (const unit of [...plan.units].reverse()) {
        mutate(capability, `disable:${unit.id}`, () => {
          state(unit).enabled = false;
          state(unit).enableMode = 'none';
        });
      }
      return serviceReceipt('disabled', true);
    },
    start(plan, capability) {
      for (let index = 0; index < plan.units.length; index += 1) {
        const unit = plan.units[index];
        mutate(capability, `start:${unit.id}`, () => { state(unit).active = true; });
        if (failStart && index === 0) {
          throw Object.assign(new Error('private supervisor detail'), { code: 'runtime_health_failed' });
        }
      }
      if (afterStart) afterStart();
      return serviceReceipt('started', true);
    },
    stop(plan, capability) {
      for (const unit of [...plan.units].reverse()) {
        mutate(capability, `stop:${unit.id}`, () => { state(unit).active = false; });
      }
      return serviceReceipt('stopped', true);
    },
    resetFailed(_plan, capability) {
      mutate(capability, 'reset-failed', () => {});
      return serviceReceipt('failure_state_reset', true);
    },
    restoreState(plan, prior, capability) {
      for (let index = 0; index < plan.units.length; index += 1) {
        const unit = plan.units[index];
        mutate(capability, `restore:${unit.id}`, () => {
          state(unit).enabled = prior[index].enabled;
          state(unit).active = prior[index].active;
          state(unit).enableMode = prior[index].enableMode;
        });
      }
      return serviceReceipt('state_restored', true);
    },
    inspect(plan) {
      if (plan.units.some(unit => !state(unit).enabled || !state(unit).active)) {
        throw Object.assign(new Error('private inspect detail'), { code: 'runtime_health_failed' });
      }
      return serviceReceipt('active');
    },
    health(plan) {
      api.inspect(plan);
      if (failHealth) throw Object.assign(new Error('private health detail'), { code: 'runtime_health_failed' });
      return serviceReceipt('healthy');
    },
  };
  return api;
}

function provisioner(paths, supervisor, ids) {
  return createDurableInstallationProvisioner({
    stateRoot: paths.stateRoot,
    installationsRoot: paths.installationsRoot,
    unitRoot: paths.unitRoot,
    runtimeAgentHubSocket: path.join(paths.stateRoot, 'central-run', 'runtime-agent-hub.sock'),
    supervisor,
    idFactory: () => ids.shift(),
  });
}

function request(operation, idempotencyKey, expectedRevision) {
  return { operation, idempotencyKey, expectedRevision };
}

function journalPhases(paths) {
  return fs.readdirSync(paths.unitRoot)
    .filter(name => name.startsWith('.dispatch-service-') && name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(paths.unitRoot, name), 'utf8')).phase)
    .sort();
}

function installedWork(paths, runtime, jobId) {
  const store = createInstallationJobStore({
    stateRoot: paths.stateRoot,
    pipelineId: INSTALLATION_SERVICE_PIPELINE_ID,
  });
  const layout = createInstallationLayoutManager({ installationsRoot: paths.installationsRoot });
  const services = createInstallationServiceManager({
    unitRoot: paths.unitRoot,
    runtimeAgentHubSocket: path.join(paths.stateRoot, 'central-run', 'runtime-agent-hub.sock'),
  });
  const supervisor = fakeSupervisor();
  store.registerFixture(runtime, authority(runtime), FIXTURE_REGISTRATION, 1_000);
  store.request(
    runtime,
    authority(runtime),
    request('provision', `${jobId}_request`, 1),
    MANAGE,
    jobId,
    1_001,
  );
  const claim = store.claimNext('worker_initial', 1_002, 100);
  const guard = mutation => store.mutateClaim(claim, 1_003, mutation);
  let current = store.work(claim, 1_003);
  assert.equal(current.stage, 'runtime_layout_materialize');
  store.completeStage(claim, current.stage, layout.materialize(runtime, authority(runtime), guard), 1_004);
  current = store.work(claim, 1_005);
  store.completeStage(claim, current.stage, layout.inspect(runtime, authority(runtime)), 1_006);
  const plan = services.plan(runtime, authority(runtime), layout.derive(runtime, authority(runtime)));
  current = store.work(claim, 1_007);
  store.completeStage(claim, current.stage, services.render(plan, guard), 1_008);
  current = store.work(claim, 1_009);
  store.completeStage(claim, current.stage, services.validate(plan), 1_010);
  current = store.work(claim, 1_011);
  store.completeStage(
    claim,
    current.stage,
    services.install(plan, supervisor.snapshot(plan), guard),
    1_012,
  );
  assert.equal(store.work(claim, 1_013).stage, 'runtime_service_start');
  return { store, layout, services, supervisor, plan, claim };
}

function restoreInstalledWork(work, claim, at, removeCandidate) {
  const guard = mutation => work.store.mutateClaim(claim, at, mutation);
  const prior = work.services.rollbackState(work.plan);
  assert.ok(prior);
  work.supervisor.stop(work.plan, guard);
  work.supervisor.disable(work.plan, guard);
  work.services.restoreFiles(work.plan, guard);
  work.supervisor.reload(work.plan, guard);
  work.supervisor.restoreState(work.plan, prior, guard);
  if (removeCandidate) work.services.removeCandidate(work.plan, guard);
  return prior;
}

test('the durable service pipeline checkpoints and verifies the server-owned runtime units', t => {
  const paths = fixture(t);
  const supervisor = fakeSupervisor();
  const runtime = manifest('a');
  const selected = provisioner(paths, supervisor, ['job_service_success']);
  t.after(() => selected.close());
  selected.registerFixture(runtime, authority(runtime), FIXTURE_REGISTRATION);
  selected.request(runtime, authority(runtime), request('provision', 'service_success_request', 1), MANAGE);
  const completed = selected.runNext('worker_service_success');
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.installationState, 'provisioning');
  assert.equal(completed.failure, null);
  assert.equal(selected.inspect(runtime, authority(runtime), READ).status, 'succeeded');
  assert.equal(selected.runNext('worker_idle').status, 'idle');
  assert.equal(fs.readdirSync(paths.unitRoot).filter(name => name.endsWith('.service')).length, INSTALLATION_AGENT_SERVICE_COUNT);
  assert.deepEqual(journalPhases(paths), ['verified']);
  assert.equal(supervisor.snapshot({ units: [...supervisor.states.keys()].map(name => ({
    id: name.includes('auth-broker') ? 'auth_broker'
      : name.includes('collection-manager') ? 'collection_manager'
        : name.includes('-agent.') ? 'runtime_agent' : 'runtime_gateway',
    name,
  })) }).every(value => value.enabled && value.active), true);
});

test('every persisted legacy service checkpoint is rejected before supervisor mutation', t => {
  const paths = fixture(t);
  const supervisor = fakeSupervisor();
  const runtime = manifest('legacy_checkpoint');
  const selected = provisioner(paths, supervisor, ['job_legacy_checkpoint']);
  selected.registerFixture(runtime, authority(runtime), FIXTURE_REGISTRATION);
  selected.request(runtime, authority(runtime), request('provision', 'legacy_checkpoint_request', 1), MANAGE);
  assert.equal(selected.runNext('worker_legacy_checkpoint').status, 'succeeded');
  selected.close();

  const database = path.join(paths.stateRoot, 'provisioner.sqlite3');
  let db = new DatabaseSync(database);
  const checkpoints = db.prepare(`SELECT stage_index,stage,receipt_json FROM job_checkpoints
    WHERE job_id=? AND stage LIKE 'runtime_service_%' ORDER BY stage_index`).all('job_legacy_checkpoint');
  db.close();
  assert.equal(checkpoints.length, 5);
  const actions = supervisor.actions.length;

  for (const checkpoint of checkpoints) {
    const legacy = { ...JSON.parse(checkpoint.receipt_json), servicePlanVersion: 1, serviceCount: 2 };
    db = new DatabaseSync(database);
    db.prepare('UPDATE job_checkpoints SET receipt_json=? WHERE job_id=? AND stage_index=?')
      .run(JSON.stringify(legacy), 'job_legacy_checkpoint', checkpoint.stage_index);
    db.close();

    assert.throws(() => provisioner(paths, supervisor, ['unused']),
      error => error?.code === 'service_installation_failed');
    assert.equal(supervisor.actions.length, actions);

    db = new DatabaseSync(database);
    db.prepare('UPDATE job_checkpoints SET receipt_json=? WHERE job_id=? AND stage_index=?')
      .run(checkpoint.receipt_json, 'job_legacy_checkpoint', checkpoint.stage_index);
    db.close();
  }
});

test('a legacy service journal is rejected before resumed service-start mutation', t => {
  const paths = fixture(t);
  const runtime = manifest('legacy_journal');
  const work = installedWork(paths, runtime, 'job_legacy_journal');
  work.store.close();
  const journalName = fs.readdirSync(paths.unitRoot)
    .find(name => name.startsWith('.dispatch-service-') && name.endsWith('.json'));
  assert.ok(journalName);
  const journalPath = path.join(paths.unitRoot, journalName);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  fs.writeFileSync(journalPath, JSON.stringify({ ...journal, servicePlanVersion: 1 }), { mode: 0o600 });

  const actions = work.supervisor.actions.length;
  const selected = provisioner(paths, work.supervisor, ['unused']);
  t.after(() => selected.close());
  selected.runNext('worker_legacy_journal');
  assert.equal(work.supervisor.actions.length, actions);
});

test('partial service start rolls back before a retry succeeds', t => {
  const paths = fixture(t);
  const supervisor = fakeSupervisor({ failStart: true });
  const runtime = manifest('b');
  const selected = provisioner(paths, supervisor, ['job_service_failure', 'job_service_retry']);
  t.after(() => selected.close());
  selected.registerFixture(runtime, authority(runtime), FIXTURE_REGISTRATION);
  selected.request(runtime, authority(runtime), request('provision', 'service_failure_request', 1), MANAGE);
  const failed = selected.runNext('worker_service_failure');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure, {
    code: 'runtime_health_failed', category: 'infrastructure', recoverable: true,
  });
  assert.equal(fs.readdirSync(paths.unitRoot).filter(name => name.endsWith('.service')).length, 0);
  assert.deepEqual(journalPhases(paths), ['restored']);
  assert.equal([...supervisor.states.values()].every(value => !value.enabled && !value.active), true);

  supervisor.setFailStart(false);
  selected.request(
    runtime,
    authority(runtime),
    request('retry', 'service_retry_request', failed.revision),
    MANAGE,
  );
  const retried = selected.runNext('worker_service_retry');
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.installationState, 'provisioning');
  assert.deepEqual(journalPhases(paths), ['verified']);
});

test('cancellation after service start rolls back and removes the inactive candidate', t => {
  const paths = fixture(t);
  const supervisor = fakeSupervisor();
  const runtime = manifest('c');
  const selected = provisioner(paths, supervisor, ['job_service_cancel']);
  t.after(() => selected.close());
  selected.registerFixture(runtime, authority(runtime), FIXTURE_REGISTRATION);
  selected.request(runtime, authority(runtime), request('provision', 'service_cancel_provision_request', 1), MANAGE);
  supervisor.setAfterStart(() => {
    supervisor.setAfterStart(null);
    selected.request(runtime, authority(runtime), request('cancel', 'service_cancel_request', 2), MANAGE);
  });
  const cancelled = selected.runNext('worker_service_cancel');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.installationState, 'pending');
  assert.equal(fs.readdirSync(paths.unitRoot).filter(name => name.endsWith('.service')).length, 0);
  assert.deepEqual(journalPhases(paths), ['restored']);
  assert.equal([...supervisor.states.values()].every(value => !value.enabled && !value.active), true);
  const configRoot = path.join(paths.installationsRoot, runtime.runtime.key, 'config');
  assert.deepEqual(fs.readdirSync(configRoot), []);
});

test('expired service cancellation is reclaimed as durable compensation', t => {
  const paths = fixture(t);
  const runtime = manifest('d');
  const work = installedWork(paths, runtime, 'job_service_reclaim');
  t.after(() => work.store.close());
  work.store.request(
    runtime,
    authority(runtime),
    request('cancel', 'service_reclaim_cancel_request', 2),
    MANAGE,
    'ignored_cancel_job',
    1_020,
  );
  const compensationClaim = work.store.claimNext('worker_compensation', 1_103, 100);
  const compensation = work.store.work(compensationClaim, 1_104);
  assert.equal(compensation.compensating, true);
  assert.equal(compensation.compensationIntent, 'cancelled');
  assert.throws(
    () => work.store.mutateClaim(work.claim, 1_104, () => {}),
    error => error?.code === 'installation_operation_in_progress',
  );
  restoreInstalledWork(work, compensationClaim, 1_105, true);
  const cancelled = work.store.finishCompensation(compensationClaim, 1_106);
  work.services.finishRollback(work.plan);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.installationState, 'pending');
  assert.deepEqual(fs.readdirSync(paths.unitRoot), []);
});

test('attempt exhaustion compensates installed services before terminal failure', t => {
  const paths = fixture(t);
  const runtime = manifest('e');
  const work = installedWork(paths, runtime, 'job_service_exhaustion');
  t.after(() => work.store.close());
  let claim = work.claim;
  let claimedAt = 1_103;
  for (let attempt = 2; attempt <= 8; attempt += 1) {
    claim = work.store.claimNext(`worker_attempt_${attempt}`, claimedAt, 100);
    assert.equal(work.store.work(claim, claimedAt + 1).compensating, false);
    claimedAt += 101;
  }
  const compensationClaim = work.store.claimNext('worker_exhaustion_rollback', claimedAt, 100);
  const compensation = work.store.work(compensationClaim, claimedAt + 1);
  assert.equal(compensation.compensating, true);
  assert.equal(compensation.compensationIntent, 'failed');
  restoreInstalledWork(work, compensationClaim, claimedAt + 2, false);
  const failed = work.store.finishCompensation(compensationClaim, claimedAt + 3);
  work.services.finishRollback(work.plan);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.code, 'installation_operation_failed');
  assert.equal(fs.readdirSync(paths.unitRoot).filter(name => name.endsWith('.service')).length, 0);
});

test('rollback retries are code-owned and bounded', t => {
  const paths = fixture(t);
  const runtime = manifest('f');
  const work = installedWork(paths, runtime, 'job_service_rollback_bound');
  t.after(() => work.store.close());
  work.store.beginCompensation(
    work.claim,
    'failed',
    Object.assign(new Error('private'), { code: 'runtime_health_failed' }),
    1_020,
  );
  let claim = work.claim;
  let terminal = null;
  for (let attempt = 1; attempt <= INSTALLATION_ROLLBACK_MAX_ATTEMPTS; attempt += 1) {
    terminal = work.store.failCompensation(claim, 1_020 + attempt);
    if (attempt < INSTALLATION_ROLLBACK_MAX_ATTEMPTS) {
      assert.equal(terminal.status, 'running');
      claim = work.store.claimNext(`worker_rollback_${attempt + 1}`, 1_030 + attempt, 100);
      assert.equal(work.store.work(claim, 1_031 + attempt).compensating, true);
    }
  }
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.failure.code, 'service_installation_failed');
  assert.equal(terminal.installationState, 'failed');
});
