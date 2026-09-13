'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  INSTALLATION_LAYOUT_TEMPLATE,
  PRIVATE_DIRECTORY_MODE,
  createInstallationLayoutManager,
  INSTALLATION_SERVICE_PLAN_VERSION,
  INSTALLATION_SERVICE_COUNT,
  INSTALLATION_AGENT_SERVICE_COUNT,
  createInstallationServiceManager,
} = require('../src');

function selectedManifest(id) {
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

function authority(manifest) {
  return {
    revision: manifest.revision,
    organization: { ...manifest.organization },
    runtime: { ...manifest.runtime },
  };
}

function isCode(code) {
  return error => error?.code === code && error.message === code;
}

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
  fs.chmodSync(temporary, PRIVATE_DIRECTORY_MODE);
  const root = path.join(temporary, 'x y');
  const installationsRoot = path.join(root, 'installations');
  const unitRoot = path.join(root, 'units');
  fs.mkdirSync(root, { mode: PRIVATE_DIRECTORY_MODE });
  fs.mkdirSync(installationsRoot, { mode: PRIVATE_DIRECTORY_MODE });
  fs.mkdirSync(unitRoot, { mode: PRIVATE_DIRECTORY_MODE });
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { temporary, installationsRoot, unitRoot };
}

test('managed service plans include a supervised outbound Runtime Agent when configured', t => {
  const { temporary, installationsRoot, unitRoot } = fixture(t);
  const layoutManager = createInstallationLayoutManager({ installationsRoot });
  const runtimeAgentHubSocket = path.join(temporary, 'central-run', 'runtime-agent-hub.sock');
  const serviceManager = createInstallationServiceManager({ unitRoot, runtimeAgentHubSocket });
  const alpha = selectedManifest('a');
  const bravo = selectedManifest('b');
  layoutManager.materialize(alpha, authority(alpha));
  layoutManager.materialize(bravo, authority(bravo));
  const alphaPlan = serviceManager.plan(alpha, authority(alpha), layoutManager.derive(alpha, authority(alpha)));
  const bravoPlan = serviceManager.plan(bravo, authority(bravo), layoutManager.derive(bravo, authority(bravo)));

  assert.equal(alphaPlan.servicePlanVersion, INSTALLATION_SERVICE_PLAN_VERSION);
  assert.equal(alphaPlan.units.length, INSTALLATION_AGENT_SERVICE_COUNT);
  assert.deepEqual(alphaPlan.units.map(unit => unit.id), [
    'auth_broker', 'collection_manager', 'runtime_gateway', 'runtime_agent',
  ]);
  assert.equal(alphaPlan.units.some(unit => bravoPlan.units.some(other => other.name === unit.name)), false);
  assert.notEqual(alphaPlan.candidateRoot, bravoPlan.candidateRoot);
  assert.equal(serviceManager.render(alphaPlan).changed, true);
  assert.equal(serviceManager.render(alphaPlan).changed, false);
  assert.equal(serviceManager.render(bravoPlan).changed, true);
  assert.deepEqual(serviceManager.validate(alphaPlan), {
    servicePlanVersion: INSTALLATION_SERVICE_PLAN_VERSION,
    status: 'validated',
    serviceCount: INSTALLATION_AGENT_SERVICE_COUNT,
    changed: false,
  });
  assert.equal(serviceManager.validate(bravoPlan).status, 'validated');

  const auth = alphaPlan.units.find(unit => unit.id === 'auth_broker');
  const collection = alphaPlan.units.find(unit => unit.id === 'collection_manager');
  const gateway = alphaPlan.units.find(unit => unit.id === 'runtime_gateway');
  const agent = alphaPlan.units.find(unit => unit.id === 'runtime_agent');
  assert.match(auth.content, /Restart=always/);
  assert.match(auth.content, /KillMode=control-group/);
  assert.match(auth.content, /StartLimitBurst=5/);
  assert.match(collection.content, new RegExp(`After=local-fs.target ${auth.name.replaceAll('.', '\\.')}`));
  assert.match(gateway.content, new RegExp(auth.name.replaceAll('.', '\\.')));
  assert.match(gateway.content, new RegExp(collection.name.replaceAll('.', '\\.')));
  assert.match(agent.content, new RegExp(gateway.name.replaceAll('.', '\\.')));
  for (const unit of alphaPlan.units) {
    assert.equal(unit.content.includes('Environment=DISPATCH_LOCAL_ROOT='), false);
    assert.equal(unit.content.includes('Environment=DISPATCH_ACCESS_CONTROL'), false);
    assert.equal(unit.content.includes('\nEnvironment='), false);
    assert.equal(unit.content.includes('--ignore-environment'), true);
    assert.equal(unit.content.includes('x\\x20y'), true);
    const info = fs.lstatSync(unit.candidate);
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o7777, 0o600);
  }
  assert.equal(auth.content.includes('DISPATCH_PAYCOM_DATA_ROOT'), false);
  assert.equal(collection.content.includes('DISPATCH_PAYCOM_DATA_ROOT'), true);
  assert.equal(collection.content.includes('DISPATCH_CDF_DATA_ROOT'), true);
  assert.equal(collection.environment.DISPATCH_MANAGED_RUNTIME, '1');
  assert.equal(Object.hasOwn(auth.environment, 'DISPATCH_MANAGED_RUNTIME'), false);
  assert.equal(Object.hasOwn(gateway.environment, 'DISPATCH_MANAGED_RUNTIME'), false);
  assert.equal(gateway.content.includes('DISPATCH_RUNTIME_GATEWAY_SOCKET'), true);
  assert.equal(gateway.content.includes('DISPATCH_RUNTIME_KEY'), true);
  assert.equal(agent.environment.DISPATCH_RUNTIME_AGENT_HUB_SOCKET, runtimeAgentHubSocket);
  assert.equal(agent.environment.DISPATCH_RUNTIME_AGENT_TOKEN_FILE.endsWith('/secrets/runtime-agent/registration-token'), true);
  assert.equal(agent.environment.DISPATCH_RUNTIME_AGENT_STATUS_SOCKET.endsWith('/run/runtime-agent-status.sock'), true);
  assert.equal(gateway.content.includes('DISPATCH_ACCESS_CONTROL_DATABASE_ROOT='), false);
  assert.deepEqual(Object.keys(serviceManager.render(alphaPlan)).sort(), [
    'changed', 'serviceCount', 'servicePlanVersion', 'status',
  ]);
});

test('service installation is restart-safe and rollback restores prior units', t => {
  const { installationsRoot, unitRoot } = fixture(t);
  const layoutManager = createInstallationLayoutManager({ installationsRoot });
  const serviceManager = createInstallationServiceManager({ unitRoot });
  const selected = selectedManifest('t');
  layoutManager.materialize(selected, authority(selected));
  const plan = serviceManager.plan(selected, authority(selected), layoutManager.derive(selected, authority(selected)));
  serviceManager.render(plan);
  serviceManager.validate(plan);
  const priorContents = plan.units.map((unit, index) => `prior ${unit.id} unit ${index}\n`);
  const priorState = plan.units.map((unit, index) => {
    fs.writeFileSync(unit.installed, priorContents[index], { mode: 0o600 });
    return {
      id: unit.id,
      name: unit.name,
      enabled: true,
      active: index === 0,
      enableMode: 'persistent',
    };
  });

  assert.equal(serviceManager.install(plan, priorState).status, 'installed');
  assert.equal(serviceManager.install(plan, priorState).changed, false);
  assert.deepEqual(serviceManager.rollbackState(plan), priorState);
  for (const unit of plan.units) assert.equal(fs.readFileSync(unit.installed, 'utf8'), unit.content);

  assert.equal(serviceManager.restoreFiles(plan).status, 'restored');
  for (let index = 0; index < plan.units.length; index += 1) {
    assert.equal(fs.readFileSync(plan.units[index].installed, 'utf8'), priorContents[index]);
  }
  assert.equal(serviceManager.finishRollback(plan).status, 'rolled_back');
  assert.equal(fs.existsSync(plan.journal), false);

  const inactive = plan.units.map(unit => ({
    id: unit.id, name: unit.name, enabled: false, active: false, enableMode: 'none',
  }));
  assert.equal(serviceManager.install(plan, inactive).status, 'installed');
  assert.equal(serviceManager.markVerified(plan).status, 'verified');
  assert.equal(serviceManager.finalizeSettled(plan).status, 'committed');
  assert.equal(fs.existsSync(plan.journal), false);
  assert.equal(serviceManager.inspectInstalled(plan).status, 'installed');
});

test('rollback refuses externally drifted installed units', t => {
  const { installationsRoot, unitRoot } = fixture(t);
  const layoutManager = createInstallationLayoutManager({ installationsRoot });
  const serviceManager = createInstallationServiceManager({ unitRoot });
  const selected = selectedManifest('d');
  layoutManager.materialize(selected, authority(selected));
  const plan = serviceManager.plan(selected, authority(selected), layoutManager.derive(selected, authority(selected)));
  serviceManager.render(plan);
  const inactive = plan.units.map(unit => ({
    id: unit.id, name: unit.name, enabled: false, active: false, enableMode: 'none',
  }));
  serviceManager.install(plan, inactive);
  fs.writeFileSync(plan.units[0].installed, 'external drift\n', { mode: 0o600 });
  assert.throws(() => serviceManager.restoreFiles(plan), isCode('service_installation_failed'));
  assert.equal(fs.readFileSync(plan.units[0].installed, 'utf8'), 'external drift\n');
  assert.equal(fs.existsSync(plan.journal), true);
});

test('service-plan version drift fails closed before changing installed units', t => {
  const { installationsRoot, unitRoot } = fixture(t);
  const layoutManager = createInstallationLayoutManager({ installationsRoot });
  const serviceManager = createInstallationServiceManager({ unitRoot });
  const selected = selectedManifest('v');
  layoutManager.materialize(selected, authority(selected));
  const plan = serviceManager.plan(selected, authority(selected), layoutManager.derive(selected, authority(selected)));
  serviceManager.render(plan);
  const inactive = plan.units.map(unit => ({
    id: unit.id, name: unit.name, enabled: false, active: false, enableMode: 'none',
  }));
  serviceManager.install(plan, inactive);
  const journal = JSON.parse(fs.readFileSync(plan.journal, 'utf8'));
  fs.writeFileSync(plan.journal, `${JSON.stringify({ ...journal, servicePlanVersion: 1 })}\n`, { mode: 0o600 });
  const installed = plan.units.map(unit => fs.readFileSync(unit.installed, 'utf8'));
  assert.throws(() => serviceManager.install(plan, inactive), isCode('runtime_boundary_violation'));
  assert.deepEqual(plan.units.map(unit => fs.readFileSync(unit.installed, 'utf8')), installed);
  assert.equal(fs.existsSync(plan.journal), true);
});

test('service rendering fails closed before stale or unsafe mutation', t => {
  const { installationsRoot, unitRoot } = fixture(t);
  const layoutManager = createInstallationLayoutManager({ installationsRoot });
  const serviceManager = createInstallationServiceManager({ unitRoot });
  const selected = selectedManifest('f');
  layoutManager.materialize(selected, authority(selected));
  const layout = layoutManager.derive(selected, authority(selected));
  const plan = serviceManager.plan(selected, authority(selected), layout);

  assert.throws(() => serviceManager.render(plan, () => {
    throw Object.assign(new Error('installation_operation_in_progress'), {
      code: 'installation_operation_in_progress',
    });
  }), isCode('installation_operation_in_progress'));
  assert.equal(fs.existsSync(plan.candidateRoot), false);

  assert.equal(serviceManager.render(plan).status, 'rendered');
  fs.writeFileSync(path.join(plan.candidateRoot, 'unknown.service'), 'fixture', { mode: 0o600 });
  assert.throws(() => serviceManager.render(plan), isCode('service_installation_failed'));
  fs.rmSync(path.join(plan.candidateRoot, 'unknown.service'));

  const moved = `${unitRoot}.old`;
  fs.renameSync(unitRoot, moved);
  fs.mkdirSync(unitRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assert.throws(() => serviceManager.inspect(plan), isCode('runtime_boundary_violation'));
});

test('service planning rejects mismatched runtime and unsafe unit roots', t => {
  const { temporary, installationsRoot, unitRoot } = fixture(t);
  const layoutManager = createInstallationLayoutManager({ installationsRoot });
  const serviceManager = createInstallationServiceManager({ unitRoot });
  const alpha = selectedManifest('q');
  const bravo = selectedManifest('r');
  layoutManager.materialize(alpha, authority(alpha));
  layoutManager.materialize(bravo, authority(bravo));
  assert.throws(() => serviceManager.plan(
    alpha,
    authority(alpha),
    layoutManager.derive(bravo, authority(bravo)),
  ), isCode('runtime_identity_mismatch'));

  const longSocket = selectedManifest('s');
  longSocket.runtime.key = `fixture_${'x'.repeat(88)}`;
  const longAuthority = authority(longSocket);
  layoutManager.materialize(longSocket, longAuthority);
  assert.throws(() => serviceManager.plan(
    longSocket,
    longAuthority,
    layoutManager.derive(longSocket, longAuthority),
  ), isCode('runtime_boundary_violation'));

  const unsafe = path.join(temporary, 'unsafe-units');
  fs.mkdirSync(unsafe, { mode: 0o777 });
  assert.throws(() => createInstallationServiceManager({ unitRoot: unsafe }),
    isCode('runtime_boundary_violation'));
});


test('service planning accepts immutable root-owned code without relaxing private unit ownership', t => {
  if (process.geteuid() === 0) return t.skip('requires the non-root Core identity');
  const f = fixture(t);
  const rootCode = path.join(f.temporary, 'root-code');
  const prepared = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/install', '-d', '-o', '0', '-g', '0', '-m', '0555', rootCode]);
  if (prepared.status !== 0) return t.skip('requires noninteractive sudo for the immutable code fixture');
  assert.equal(fs.lstatSync(rootCode).uid, 0);
  assert.doesNotThrow(() => createInstallationServiceManager({ unitRoot: f.unitRoot, projectRoot: rootCode }));
  assert.throws(() => createInstallationServiceManager({ unitRoot: rootCode, projectRoot: f.temporary }), isCode('runtime_boundary_violation'));
  const writableCode = path.join(f.temporary, 'writable-code'); fs.mkdirSync(writableCode); fs.chmodSync(writableCode, 0o777);
  assert.throws(() => createInstallationServiceManager({ unitRoot: f.unitRoot, projectRoot: writableCode }), isCode('runtime_boundary_violation'));
});
