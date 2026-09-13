'use strict';

const crypto = require('node:crypto');
const { installationFailure, serverInstallationActivation } = require('../../../shared/contracts/src');
const { managedInstallationContext } = require('./installation-authority');
const { activationJobView, MAX_PROVIDER_EVIDENCE_AGE_MS } = require('./installation-activation');
const { AccessError } = require('./validation');

// The existing publication pipeline still verifies Paycom's data, but its job
// cannot change a usable DSP's installation or organization status.
function createOptionalPaycomActivation({ store, row, requests, clock = Date.now }) {
  const scope = 'optional_paycom';
  const leaseMs = 300_000;
  let claim = null;
  const fail = (code = 'installation_operation_in_progress') => { throw new AccessError(code, 409); };
  function context() {
    requests.renew(row);
    const value = managedInstallationContext(store, row.organization_id);
    if (value.installation.status !== 'ready' || value.organization.status !== 'active'
        || !value.ownerActive || value.manifest.revision !== row.manifest_revision
        || store.activeLifecycleJob(row.organization_id)
        || store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(row.organization_id)) fail();
    return value;
  }
  function latest() {
    return store.db.prepare(`SELECT * FROM installation_activation_jobs WHERE organization_id=?
      AND authority_scope=? AND substr(idempotency_key,1,?)=? ORDER BY rowid DESC LIMIT 1`)
      .get(row.organization_id, scope, row.id.length + 1, `${row.id}:`) || null;
  }
  function view(value, job) {
    return { manifest: value.manifest, manifestAuthority: value.manifestAuthority,
      installation: { state: job?.status === 'succeeded' ? 'ready' : job?.status === 'running' ? 'verifying' : 'waiting_for_provider_auth',
        revision: value.installation.revision, currentJobId: job?.id || null },
      owner: { active: value.ownerActive }, job: job ? activationJobView(job) : null };
  }
  function peek() { return store.transaction(() => view(context(), latest())); }
  function inspect() {
    return store.transaction(() => {
      const value = context();
      let job = latest();
      if (job?.status === 'running') {
        const at = clock();
        if (job.worker_id === row.worker_id && job.lease_expires_at > at) {
          job = store.renewActivationJob(job.id, row.worker_id, job.fence, at + leaseMs, at);
        } else if (job.lease_expires_at <= at) {
          job = store.claimActivationJob(job.id, row.worker_id, job.fence, at + leaseMs, at);
        } else fail();
        claim = job;
      }
      return view(value, job?.status === 'failed' ? null : job);
    });
  }
  function begin(evidence) {
    return store.transaction(() => {
      const value = context();
      const at = clock();
      const testedAt = Date.parse(evidence?.testedAt);
      if (evidence?.provider !== 'paycom' || evidence?.profileId !== 'paycom-main'
          || evidence?.status !== 'authenticated' || !Number.isSafeInteger(testedAt)
          || testedAt > at + 60_000 || at - testedAt > MAX_PROVIDER_EVIDENCE_AGE_MS) fail('provider_auth_required');
      if (store.runningActivationJob(row.organization_id)) fail();
      claim = store.createActivationJob({ id: `act_${crypto.randomBytes(16).toString('hex')}`,
        organizationId: row.organization_id, installationRevision: value.installation.revision,
        manifestRevision: value.manifest.revision, runtimeKey: value.manifest.runtime.key,
        authorityScope: scope, idempotencyKey: `${row.id}:${row.fence}`, workerId: row.worker_id,
        leaseExpiresAt: at + leaseMs, providerTestedAt: testedAt, timestamp: at });
      return view(value, claim);
    });
  }
  function checked() {
    const value = context();
    const job = claim && store.activationJob(claim.id);
    if (!job || job.status !== 'running' || job.worker_id !== row.worker_id || job.fence !== claim.fence
        || job.lease_expires_at <= clock() || job.installation_revision !== value.installation.revision
        || job.manifest_revision !== value.manifest.revision) fail();
    return { value, job };
  }
  function heartbeat() {
    return store.transaction(() => {
      const { value, job } = checked();
      claim = store.renewActivationJob(job.id, row.worker_id, job.fence, clock() + leaseMs, clock());
      return view(value, claim);
    });
  }
  function commit(activation, authority) {
    return store.transaction(() => {
      const { value, job } = checked();
      if (authority?.jobId !== job.id || JSON.stringify(authority.manifestAuthority) !== JSON.stringify(value.manifestAuthority)) fail();
      const verified = serverInstallationActivation({ ...activation, job: activationJobView(job) },
        { manifestAuthority: value.manifestAuthority, jobId: job.id });
      const at = clock();
      const captured = Date.parse(verified.evidence.capturedAt);
      if (!Number.isSafeInteger(captured) || captured > at + 60_000 || at - captured > 900_000) fail('installation_not_ready');
      store.finishActivationJob(job.id, row.worker_id, job.fence, 'succeeded', 'ready',
        value.installation.revision, null, verified.evidence, at);
      claim = null;
      return { state: 'ready', revision: value.installation.revision };
    });
  }
  function failed(jobId, error) {
    return store.transaction(() => {
      const { value, job } = checked();
      if (job.id !== jobId) fail();
      store.finishActivationJob(job.id, row.worker_id, job.fence, 'failed', 'failed',
        value.installation.revision, installationFailure(error).code, null, clock());
      claim = null;
    });
  }
  return { peek, inspect, begin, heartbeat, commit, fail: failed };
}

module.exports = { createOptionalPaycomActivation };
