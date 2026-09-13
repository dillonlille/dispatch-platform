'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createOciHostAuthority, ISSUER, AUDIENCE } = require('../src/oci-host-authority');

if (process.geteuid() !== 0) {
  test('root-owned OCI action authority rejects an ordinary process', () => {
    assert.throws(() => createOciHostAuthority({ root: '/run/unused' }), { code: 'runtime_boundary_violation' });
  });
  test('root-owned OCI action authority adversarial fixture', t => {
    const available = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/true']);
    if (available.status !== 0) return t.skip('requires noninteractive sudo for disposable /run authority fixture');
    const result = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
      '/usr/bin/node', '--no-warnings', '--test', __filename], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  function fixture(t) {
    process.umask(0o077);
    const root = fs.mkdtempSync('/run/dispatch-authority-test-');
    let now = 1000;
    const authority = createOciHostAuthority({ root, clock: () => now });
    t.after(() => { authority.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const lease = { version: 1, issuer: ISSUER, audience: AUDIENCE, organizationId: 'org_alpha',
      runtimeKey: 'runtime_alpha', installationRevision: 7, manifestRevisions: [1], backend: 'oci_container_v1',
      jobKind: 'provisioning', jobId: 'job_alpha', workerId: 'worker_alpha', generation: 1, fence: 1, expiresAt: 10_000 };
    authority.issueLease(lease);
    const request = { version: 2, operation: 'reserve_account', runtimeKey: lease.runtimeKey,
      claim: { jobId: lease.jobId, workerId: lease.workerId, generation: 1, fence: 1 } };
    const issued = () => ({ ...structuredClone(request), authorization: authority.issueAction(request) });
    let mutations = 0;
    const execute = value => authority.execute(value, guard => guard(() => { mutations += 1; return 'ok'; }));
    return { root, authority, lease, request, issued, execute, mutations: () => mutations, time: value => { now = value; } };
  }
  test('invented, substituted and replayed action claims fail before host effects', t => {
    const f = fixture(t);
    assert.throws(() => f.execute({ ...f.request, authorization: '0'.repeat(64) }), { code: 'runtime_boundary_violation' });
    const original = f.issued();
    for (const alter of [
      value => { value.operation = 'destroy_account'; },
      value => { value.runtimeKey = 'runtime_beta'; },
      value => { value.claim.workerId = 'worker_beta'; },
      value => { value.claim.jobId = 'job_beta'; },
      value => { value.claim.fence = 2; },
      value => { value.claim.generation = 2; },
      value => { value.payload = { arbitrary: true }; },
      value => { value.claim.extra = true; },
    ]) {
      const changed = structuredClone(original); alter(changed);
      assert.throws(() => f.execute(changed), { code: 'runtime_boundary_violation' });
    }
    assert.equal(f.mutations(), 0);
    assert.equal(f.execute(original), 'ok');
    assert.throws(() => f.execute(original), { code: 'runtime_boundary_violation' });
    assert.equal(f.mutations(), 1);
  });
  test('expiry, takeover, terminal revocation and permanent retirement invalidate issued actions', t => {
    const f = fixture(t);
    const expired = f.issued();
    f.time(10_000);
    assert.throws(() => f.execute(expired), { code: 'runtime_boundary_violation' });
    f.time(2000);
    const stale = f.issued();
    f.authority.issueLease({ ...f.lease, fence: 2 });
    assert.throws(() => f.execute(stale), { code: 'runtime_boundary_violation' });
    f.request.claim.fence = 2;
    const revoked = f.issued();
    f.authority.revoke(f.lease.runtimeKey);
    assert.throws(() => f.execute(revoked), { code: 'runtime_boundary_violation' });
    assert.throws(() => f.authority.issueLease({ ...f.lease, fence: 2 }), { code: 'runtime_boundary_violation' });
    f.authority.issueLease({ ...f.lease, fence: 3 });
    f.request.claim.fence = 3;
    const retired = f.issued();
    f.authority.revoke(f.lease.runtimeKey, true);
    assert.throws(() => f.execute(retired), { code: 'runtime_boundary_violation' });
    assert.throws(() => f.authority.issueLease({ ...f.lease, generation: 2 }), { code: 'runtime_boundary_violation' });
    assert.equal(f.mutations(), 0);
  });
  test('retired authority permits current destruction read-back without restoring mutation authority', t => {
    const f = fixture(t);
    f.authority.revoke(f.lease.runtimeKey, true);
    const lease = { ...f.lease, jobKind: 'lifecycle', installationRevision: 8, generation: 8 };
    for (const operation of ['reserve_account', 'prepare_account', 'destroy_account', 'backup_destroy']) {
      assert.throws(() => f.authority.synchronizeLease(lease, operation), /runtime_boundary_violation/);
    }
    f.authority.synchronizeLease(lease, 'verify_destroyed');
    const request = { version: 2, operation: 'verify_destroyed', runtimeKey: lease.runtimeKey,
      claim: { jobId: lease.jobId, workerId: lease.workerId, fence: lease.fence } };
    assert.equal(f.authority.execute({ ...request, authorization: f.authority.issueAction(request) }, () => 'absent'), 'absent');
    f.authority.revoke(lease.runtimeKey);
    assert.throws(() => f.authority.issueAction({ ...request, operation: 'destroy_account' }), /runtime_boundary_violation/);
    assert.throws(() => f.authority.issueLease({ ...lease, fence: 2 }), /runtime_boundary_violation/);
  });
  test('authority binds exact plan, installation, backend, token and backup payload', t => {
    const f = fixture(t);
    const request = { version: 2, operation: 'materialize_layout', claim: f.request.claim, token: 'synthetic',
      plan: { runtimeKey: 'runtime_alpha', backend: 'oci_container_v1', planDigest: 'a'.repeat(64),
        deployment: { organizationId: 'org_alpha', manifestRevision: 1 } } };
    const issued = { ...request, authorization: f.authority.issueAction(request) };
    for (const alter of [
      value => { value.plan.planDigest = 'b'.repeat(64); },
      value => { value.plan.backend = 'systemd_user'; },
      value => { value.plan.deployment.organizationId = 'org_beta'; },
      value => { value.plan.deployment.manifestRevision = 2; },
      value => { value.token = 'substituted'; },
      value => { value.payload = { destructionApproved: true }; },
    ]) {
      const changed = structuredClone(issued); alter(changed);
      assert.throws(() => f.execute(changed), { code: 'runtime_boundary_violation' });
    }
    assert.equal(f.mutations(), 0);
  });
  test('failed host effects consume their action durably and expiry is checked at each mutation', t => {
    const f = fixture(t);
    const request = f.issued();
    assert.throws(() => f.authority.execute(request, guard => {
      f.time(10_000);
      guard(() => { throw new Error('must not run'); });
    }), { code: 'runtime_boundary_violation' });
    f.time(2000);
    assert.throws(() => f.execute(request), { code: 'runtime_boundary_violation' });
    assert.throws(() => f.authority.issueLease({ ...f.lease, fence: 2 }), { code: 'runtime_boundary_violation' });
    assert.throws(() => f.issued(), { code: 'runtime_boundary_violation' });
    assert.equal(f.mutations(), 0);
  });
  test('renewal preserves the same action scope and fence', t => {
    const f = fixture(t);
    const request = f.issued();
    f.authority.renewLease({ ...f.lease, expiresAt: 20_000 });
    assert.throws(() => f.authority.renewLease({ ...f.lease, workerId: 'worker_beta', expiresAt: 20_000 }),
      { code: 'runtime_boundary_violation' });
    f.time(11_000);
    assert.equal(f.execute(request), 'ok');
  });
  test('lifecycle claims use the server-owned generation without fabricating a caller generation', t => {
    const f = fixture(t);
    f.authority.issueLease({ ...f.lease, jobKind: 'lifecycle', generation: 2 });
    delete f.request.claim.generation;
    const request = f.issued();
    assert.equal(f.execute(request), 'ok');
    f.authority.issueLease({ ...f.lease, jobKind: 'lifecycle', generation: 3 });
    assert.throws(() => f.execute(request), { code: 'runtime_boundary_violation' });
  });
  test('root and database replacement and unsafe modes fail closed', t => {
    const f = fixture(t);
    const request = f.issued();
    fs.chmodSync(f.root, 0o750);
    assert.throws(() => f.execute(request), { code: 'runtime_boundary_violation' });
    fs.chmodSync(f.root, 0o700);
    const file = path.join(f.root, 'authority.sqlite3');
    fs.renameSync(file, `${file}.old`);
    fs.writeFileSync(file, '', { mode: 0o600 });
    assert.throws(() => f.execute(request), { code: 'runtime_boundary_violation' });
    assert.equal(f.mutations(), 0);
  });
  test('supervised recovery retains the in-flight gate until quiescence is proven', t => {
    const f = fixture(t);
    const request = f.issued();
    assert.throws(() => f.authority.execute(request, () => { throw new Error('interrupted'); }), /interrupted/);
    assert.throws(() => f.authority.recover(f.lease.runtimeKey, () => false), /runtime_boundary_violation/);
    assert.throws(() => f.authority.synchronizeLease(f.lease), /runtime_boundary_violation/);
    assert.equal(f.authority.recover(f.lease.runtimeKey, ids => {
      assert.deepEqual(ids, [request.authorization]); return true;
    }), true);
    assert.throws(() => f.execute(request), /runtime_boundary_violation/);
    f.authority.synchronizeLease(f.lease);
    assert.equal(f.execute(f.issued()), 'ok');
  });
  test('Access Control operation revisions order provisioning and lifecycle epochs', t => {
    const f = fixture(t);
    f.authority.issueLease({ ...f.lease, installationRevision: 8, jobKind: 'lifecycle', generation: 8, fence: 1 });
    f.authority.revoke(f.lease.runtimeKey);
    f.authority.issueLease({ ...f.lease, installationRevision: 9, generation: 2, fence: 1 });
    assert.throws(() => f.authority.synchronizeLease({ ...f.lease, installationRevision: 8,
      jobKind: 'lifecycle', generation: 99 }), /runtime_boundary_violation/);
  });
}
