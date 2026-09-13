'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { authorizeHostRequest } = require('../src/oci-host-permissions');
const claim = { jobId: 'job_permissions', workerId: 'worker_permissions', generation: 1, fence: 2 };
const manifest = { revision: 3, organization: { id: 'org_permissions' }, runtime: { key: 'runtime_permissions', releaseId: 'release_current' } };
const snapshot = { kind: 'provisioning', claim, manifest, backend: 'oci_container_v1',
  stage: 'runtime_oci_host_account', compensation: false, operation: 'provision', installationRevision: 7, expiresAt: Date.now() + 60000 };
const request = { version: 2, operation: 'reserve_account', runtimeKey: manifest.runtime.key, claim };
test('host permission uses the authoritative epoch and exact native claim', () => {
  const lease = authorizeHostRequest(snapshot, request);
  assert.equal(lease.installationRevision, 7);
  assert.deepEqual(lease.manifestRevisions, [3]);
  assert.equal(lease.generation, 1);
  assert.throws(() => authorizeHostRequest(snapshot, { ...request, claim: { ...claim, fence: 3 } }), /runtime_boundary_violation/);
  assert.throws(() => authorizeHostRequest(snapshot, { ...request, runtimeKey: 'runtime_other' }), /runtime_boundary_violation/);
});
test('provisioning stage and compensation forbid forward or destructive substitutions', () => {
  for (const operation of ['start', 'destroy_account', 'backup_destroy', 'rollback', 'settle_committed']) {
    assert.throws(() => authorizeHostRequest(snapshot, { ...request, operation }), /runtime_boundary_violation/);
  }
  assert.throws(() => authorizeHostRequest({ ...snapshot, compensation: true }, request), /runtime_boundary_violation/);
  assert.equal(authorizeHostRequest({ ...snapshot, compensation: true }, { ...request, operation: 'rollback' }).jobId, claim.jobId);
});
test('lifecycle grants target release only in release stages and compensation', () => {
  const { generation, ...native } = claim;
  const s = { ...snapshot, kind: 'lifecycle', claim: native, operation: 'upgrade', stage: 'install_release', targetReleaseId: 'release_target' };
  const r = { version: 2, claim: native, operation: 'install', plan: { runtimeKey: manifest.runtime.key,
    backend: s.backend, deployment: { organizationId: manifest.organization.id, manifestRevision: 4 }, release: { releaseId: 'release_target' } } };
  assert.deepEqual(authorizeHostRequest(s, r).manifestRevisions, [3, 4]);
  assert.equal(authorizeHostRequest(s, r).generation, 7);
  assert.throws(() => authorizeHostRequest({ ...s, stage: 'stop_runtime' }, { ...r, operation: 'stop' }), /runtime_boundary_violation/);
  assert.throws(() => authorizeHostRequest(s, { ...r, plan: { ...r.plan, release: { releaseId: 'release_forged' } } }), /runtime_boundary_violation/);
});
