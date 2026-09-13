'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { ManagedRuntimeServicePort, createManagedPaycomAuthSetup } = require('../../../compatibility/provisioner/src/managed-auth-setup.js');

function fixture() {
  const plan = { units: [{ id: 'auth' }, { id: 'manager' }, { id: 'gateway' }] };
  let active = true;
  let guards = 0;
  let health = 0;
  const authority = {
    guard(mutation) {
      guards += 1;
      return mutation();
    },
  };
  const supervisor = {
    snapshot: () => plan.units.map(unit => ({ id: unit.id, active })),
    health: () => { health += 1; },
    stop: (_plan, mutate) => mutate(() => { active = false; }),
    start: (_plan, mutate) => mutate(() => { active = true; }),
  };
  return { plan, authority, supervisor, values: () => ({ active, guards, health }) };
}

test('managed credential setup controls the complete server-owned runtime service set through the authority guard', async () => {
  const context = fixture();
  const service = new ManagedRuntimeServicePort(context);
  assert.deepEqual(await service.status(), { status: 'ready', managed: true });
  assert.deepEqual(await service.stop(), { status: 'stopped', managed: true, stopped: true });
  assert.deepEqual(await service.status(), { status: 'stopped', managed: true });
  assert.deepEqual(await service.start(), { status: 'ready', managed: true, started: true });
  assert.deepEqual(context.values(), { active: true, guards: 2, health: 2 });
});

test('managed credential setup refuses a partially active runtime', async () => {
  const context = fixture();
  context.supervisor.snapshot = () => [
    { id: 'auth', active: false },
    { id: 'manager', active: true },
    { id: 'gateway', active: false },
  ];
  const service = new ManagedRuntimeServicePort(context);
  await assert.rejects(service.status(), /broker_state_unknown/);
});

test('managed activation CLI requires explicit create or replace credential intent', () => {
  const executable = path.resolve(__dirname, "../../../compatibility/provisioner/bin/dispatch-managed-activation");
  for (const argv of [
    ['setup-auth', 'org_activation_fixture'],
    ['setup-auth', 'org_activation_fixture', 'auto'],
    ['setup-auth', 'org_activation_fixture', 'keep'],
  ]) {
    const result = spawnSync(process.execPath, ['--no-warnings', executable, ...argv], {
      encoding: 'utf8',
      env: {},
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, 'invalid_input');
    assert.equal(result.stderr, '');
  }
});

test('managed credential setup rejects a crossed Access Control manifest before reading runtime paths', () => {
  const manifest = {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_alpha', stationCode: 'TST1', timezone: 'America/Chicago' },
    runtime: { key: 'runtime_alpha', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_current_1' },
  };
  const manifestAuthority = {
    revision: 1,
    organizationId: 'org_alpha',
    stationCode: 'TST1',
    timezone: 'America/Chicago',
    runtimeKey: 'runtime_alpha',
    templateId: 'isolated_dsp_v1',
    releaseId: 'dispatch_current_1',
  };
  const crossed = structuredClone(manifest);
  crossed.organization.id = 'org_bravo';
  crossed.runtime.key = 'runtime_bravo';
  assert.throws(() => createManagedPaycomAuthSetup({
    manifest,
    manifestAuthority,
    authority: {
      peek: () => ({
        manifest: crossed,
        manifestAuthority: {
          ...manifestAuthority, organizationId: 'org_bravo', runtimeKey: 'runtime_bravo',
        },
        installation: { state: 'waiting_for_provider_auth' },
      }),
      beginSetup: () => null,
      endSetup: () => null,
      guard: mutation => mutation(),
    },
    installationsRoot: '/unread-installations-root',
    unitRoot: '/unread-unit-root',
    supervisor: {},
  }), error => error?.code === 'runtime_identity_mismatch');
});
