'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessStore } = require('../src/store');
const { createAccessRuntimeAgentAuthorityCatalog } = require('../src/runtime-agent-authority');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-authority-'));
  fs.chmodSync(root, 0o700);
  const databaseRoot = path.join(root, 'access');
  const store = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') });
  store.transaction(() => {
    store.createOrganization({
      id: 'org_agent_alpha', name: 'Agent Alpha', abbreviation: 'AA',
      timezone: 'America/Los_Angeles', status: 'active', createdBy: null, timestamp: 1_000,
    });
    store.insertStation('org_agent_alpha', 'TST1', true, 1_000);
    store.createInstallation('org_agent_alpha', 'runtime_agent_alpha', 'provisioning', 1_000);
    store.createOrganization({
      id: 'org_agent_bravo', name: 'Agent Bravo', abbreviation: 'AB',
      timezone: 'America/New_York', status: 'active', createdBy: null, timestamp: 1_000,
    });
    store.insertStation('org_agent_bravo', 'TST2', true, 1_000);
    store.createInstallation('org_agent_bravo', 'runtime_agent_bravo', 'provisioning', 1_000);
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, database: path.join(databaseRoot, 'access-control.sqlite3') };
}

test('Access Control owns runtime-agent authority, rotation, and revocation', t => {
  const { store, database } = fixture(t);
  const alphaToken = crypto.randomBytes(32).toString('base64url');
  const alphaDigest = digest(alphaToken);
  const first = store.recordRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    tokenHash: alphaDigest, timestamp: 2_000,
  });
  assert.deepEqual(first, {
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    tokenHash: alphaDigest, generation: 1, status: 'active', changed: true,
  });
  assert.equal(store.recordRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    tokenHash: alphaDigest, timestamp: 2_001,
  }).changed, false);

  const catalog = createAccessRuntimeAgentAuthorityCatalog({ store });
  assert.deepEqual(catalog.resolve('runtime_agent_alpha'), { digest: alphaDigest, generation: 1 });
  assert.equal(catalog.count(), 1);
  assert.equal(catalog.resolve('runtime_agent_bravo'), null);

  const rotatedToken = crypto.randomBytes(32).toString('base64url');
  const rotatedDigest = digest(rotatedToken);
  const rotated = store.replaceRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    tokenHash: rotatedDigest, expectedGeneration: 1, expectedStatus: 'active', timestamp: 3_000,
  });
  assert.equal(rotated.generation, 2);
  assert.equal(catalog.resolve('runtime_agent_alpha').digest, rotatedDigest);

  store.updateOrganizationStatus('org_agent_alpha', 'suspended', 3_100);
  assert.equal(catalog.resolve('runtime_agent_alpha'), null);
  assert.equal(catalog.count(), 0);
  store.updateOrganizationStatus('org_agent_alpha', 'active', 3_200);
  store.updateInstallationControl({
    organizationId: 'org_agent_alpha', expectedStatus: 'provisioning', expectedRevision: 1,
    status: 'suspended', revision: 2, currentJobId: null, timestamp: 3_300,
  });
  assert.equal(store.installationControl('org_agent_alpha').status, 'suspended');
  assert.equal(catalog.resolve('runtime_agent_alpha').generation, 2);

  assert.equal(store.revokeRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    expectedGeneration: 2, timestamp: 4_000,
  }), true);
  assert.throws(() => store.revokeRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    expectedGeneration: 2, timestamp: 4_001,
  }), error => error?.code === 'runtime_agent_authority_conflict');
  assert.throws(() => store.recordRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    tokenHash: rotatedDigest, timestamp: 4_002,
  }), error => error?.code === 'runtime_agent_unauthorized');
  assert.throws(() => store.replaceRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_alpha',
    tokenHash: digest(crypto.randomBytes(32).toString('base64url')),
    expectedGeneration: 2, expectedStatus: 'active', timestamp: 4_003,
  }), error => error?.code === 'runtime_agent_authority_conflict');
  assert.equal(catalog.resolve('runtime_agent_alpha'), null);
  assert.equal(fs.readFileSync(database).includes(Buffer.from(alphaToken)), false);
  assert.equal(fs.readFileSync(database).includes(Buffer.from(rotatedToken)), false);
});

test('runtime-agent authority cannot be rebound to another installation', t => {
  const { store } = fixture(t);
  assert.throws(() => store.recordRuntimeAgentAuthority({
    organizationId: 'org_agent_alpha', runtimeKey: 'runtime_agent_bravo',
    tokenHash: digest(crypto.randomBytes(32).toString('base64url')), timestamp: 2_000,
  }), error => error?.code === 'runtime_identity_mismatch');
});
