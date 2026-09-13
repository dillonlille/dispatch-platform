'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createInstallationRuntimeResolver } = require('../server/runtime-router');

function client(label) {
  return {
    label,
    workforce: { day: async () => ({}) },
    sync: { status: async () => ({}), runNow: async () => ({}) },
    system: { status: async () => ({}) },
  };
}

function installation(organizationId, runtimeKey, status = 'ready') {
  return { organizationId, runtimeKey, status };
}

function isCode(code) { return error => error?.code === code; }

test('runtime routing is derived from the authority-bound installation only', () => {
  const local = client('local');
  const hub = { invoke: async () => ({}) };
  const created = [];
  const remote = client('alpha');
  const resolve = createInstallationRuntimeResolver({
    localClient: local,
    runtimeAgentHub: hub,
    runtimeAgentClientFactory: options => { created.push(options); return remote; },
  });

  assert.equal(resolve(installation('local-dsp', 'local'), { id: 'local-dsp' }), local);
  assert.throws(() => resolve(installation('org_alpha', 'local'), { id: 'org_alpha' }),
    isCode('runtime_identity_mismatch'));
  assert.equal(resolve(installation('org_alpha', 'fixture_alpha'), { id: 'org_alpha' }), remote);
  assert.equal(resolve(installation('org_alpha', 'fixture_alpha'), { id: 'org_alpha' }), remote);
  assert.deepEqual(created, [{ hub, runtimeKey: 'fixture_alpha' }]);
  assert.throws(() => resolve(installation('org_bravo', 'fixture_alpha'), { id: 'org_alpha' }),
    isCode('runtime_identity_mismatch'));
  assert.throws(() => resolve(installation('org_alpha', 'fixture_alpha', 'pending'), { id: 'org_alpha' }),
    isCode('runtime_identity_mismatch'));
});

test('local-only routing refuses managed installations and legacy direct-socket configuration', () => {
  const local = client('local');
  const resolve = createInstallationRuntimeResolver({ localClient: local });
  assert.equal(resolve(installation('local-dsp', 'local'), { id: 'local-dsp' }), local);
  assert.equal(resolve(installation('org_alpha', 'fixture_alpha'), { id: 'org_alpha' }), null);
  assert.throws(() => createInstallationRuntimeResolver({
    localClient: local,
    installationsRoot: '/tmp/not-authority',
  }), /runtime_resolver_dependencies_required/);
});
