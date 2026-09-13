'use strict';

const crypto = require('node:crypto');
const {
  IDEMPOTENCY_RE,
  installationFailure,
  installationJob,
  installationActivationEvidence,
  installationTransition,
  serverInstallationActivation,
} = require('../../../shared/contracts/src');
const { AccessError, identifier } = require('./validation');
const {
  DEFAULT_MANAGED_TEMPLATE_ID,
  DEFAULT_MANAGED_RELEASE_ID,
  managedInstallationContext,
} = require('./installation-authority');

const DEFAULT_ACTIVATION_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_SETUP_LEASE_MS = 20 * 60 * 1000;
const MAX_PROVIDER_EVIDENCE_AGE_MS = 15 * 60 * 1000;
const MAX_ACTIVATION_EVIDENCE_AGE_MS = 15 * 60 * 1000;


function fail(code, statusCode = 409) {
  throw new AccessError(code, statusCode);
}

function activationJobView(row, replayed = false) {
  if (!row) fail('installation_operation_not_found');
  return installationJob({
    id: row.id,
    operation: row.operation,
    status: row.status,
    installationState: row.installation_state,
    revision: row.installation_revision,
    replayed,
    failure: row.failure_code === null ? null : installationFailure(row.failure_code),
  });
}

function providerEvidence(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'profileId,provider,status,testedAt'
      || value.profileId !== 'paycom-main' || value.provider !== 'paycom'
      || value.status !== 'authenticated' || typeof value.testedAt !== 'string') {
    fail('provider_auth_required');
  }
  const testedAt = Date.parse(value.testedAt);
  if (!Number.isSafeInteger(testedAt) || testedAt > now + 60_000 || now - testedAt > MAX_PROVIDER_EVIDENCE_AGE_MS) {
    fail('provider_auth_required');
  }
  return testedAt;
}

function createAccessInstallationActivationAuthority(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => ![
        'store', 'organizationId', 'authorityScope', 'idempotencyKey', 'workerId', 'clock',
        'leaseMs', 'setupLeaseMs', 'jobFactory', 'templateId', 'releaseId',
      ].includes(key))) fail('runtime_boundary_violation', 500);
  const store = options.store;
  if (!store || !['transaction', 'installationControl', 'installationSetup', 'activationJob']
    .every(method => typeof store[method] === 'function')) fail('runtime_boundary_violation', 500);
  const organizationId = identifier(options.organizationId);
  const authorityScope = identifier(options.authorityScope);
  const workerId = identifier(options.workerId);
  const idempotencyKey = options.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 || idempotencyKey.length > 128
      || !IDEMPOTENCY_RE.test(idempotencyKey)) fail('invalid_input', 400);
  const clock = options.clock === undefined ? Date.now : options.clock;
  const jobFactory = options.jobFactory === undefined
    ? () => `act_${crypto.randomUUID().replaceAll('-', '')}` : options.jobFactory;
  const leaseMs = options.leaseMs === undefined ? DEFAULT_ACTIVATION_LEASE_MS : options.leaseMs;
  const setupLeaseMs = options.setupLeaseMs === undefined ? DEFAULT_SETUP_LEASE_MS : options.setupLeaseMs;
  const templateId = options.templateId === undefined ? DEFAULT_MANAGED_TEMPLATE_ID : options.templateId;
  const releaseId = options.releaseId === undefined ? DEFAULT_MANAGED_RELEASE_ID : options.releaseId;
  if (typeof clock !== 'function' || typeof jobFactory !== 'function'
      || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 2 * 60 * 60 * 1000
      || !Number.isSafeInteger(setupLeaseMs) || setupLeaseMs < 10_000 || setupLeaseMs > 2 * 60 * 60 * 1000
      || !/^[a-z][a-z0-9_.-]{2,95}$/.test(templateId)
      || !/^[a-z][a-z0-9_.-]{2,95}$/.test(releaseId)) fail('runtime_boundary_violation', 500);
  let claim = null;
  let setupClaim = null;

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) fail('installation_operation_failed', 500);
    return value;
  }

  function manifestContext() {
    return managedInstallationContext(store, organizationId, { templateId, releaseId });
  }

  function requireUsableOrganization(context) {
    if (!context.ownerActive || !['setup_required', 'active'].includes(context.organization.status)) {
      fail('installation_not_ready');
    }
  }

  function claimRow(row, timestamp) {
    if (!row || row.status !== 'running') fail('installation_not_ready');
    if (row.worker_id === workerId && row.lease_expires_at > timestamp) {
      row = store.renewActivationJob(row.id, workerId, row.fence, timestamp + leaseMs, timestamp);
    } else if (row.lease_expires_at <= timestamp) {
      row = store.claimActivationJob(row.id, workerId, row.fence, timestamp + leaseMs, timestamp);
    } else {
      fail('installation_operation_in_progress');
    }
    claim = Object.freeze({ id: row.id, fence: row.fence });
    return row;
  }

  function contextView(context, row = null, replayed = false) {
    return Object.freeze({
      manifest: context.manifest,
      manifestAuthority: Object.freeze(context.manifestAuthority),
      installation: Object.freeze({
        state: context.installation.status,
        revision: context.installation.revision,
        currentJobId: context.installation.currentJobId,
      }),
      job: row ? activationJobView(row, replayed) : null,
      owner: Object.freeze({ active: context.ownerActive }),
    });
  }

  function completedRow(context) {
    if (context.installation.status !== 'ready' || !context.installation.currentJobId) {
      fail('installation_not_ready');
    }
    const row = store.activationJob(context.installation.currentJobId);
    if (!row || row.status !== 'succeeded' || row.installation_state !== 'ready'
        || row.installation_revision !== context.installation.revision
        || row.manifest_revision !== context.installation.manifestRevision
        || row.runtime_key !== context.installation.runtimeKey || row.evidence_json === null
        || row.evidence_digest === null) fail('installation_not_ready');
    let evidence;
    try { evidence = installationActivationEvidence(JSON.parse(row.evidence_json)); }
    catch { fail('installation_not_ready'); }
    if (evidence.evidenceDigest !== row.evidence_digest || evidence.jobId !== row.id) {
      fail('installation_not_ready');
    }
    return row;
  }

  function peek() {
    return store.transaction(() => {
      const context = manifestContext();
      requireUsableOrganization(context);
      if (context.installation.status === 'waiting_for_provider_auth') {
        if (context.installation.currentJobId !== null) fail('runtime_boundary_violation', 500);
        return contextView(context);
      }
      if (context.installation.status === 'ready') return contextView(context, completedRow(context), true);
      if (context.installation.status !== 'verifying' || !context.installation.currentJobId) {
        fail('installation_not_ready');
      }
      const row = store.activationJob(context.installation.currentJobId);
      if (!row || row.status !== 'running') fail('installation_not_ready');
      return contextView(context, row, row.authority_scope === authorityScope
        && row.idempotency_key === idempotencyKey);
    });
  }

  function inspect() {
    return store.transaction(() => {
      const timestamp = now();
      const context = manifestContext();
      requireUsableOrganization(context);
      if (context.installation.status === 'waiting_for_provider_auth') {
        if (context.installation.currentJobId !== null) fail('runtime_boundary_violation', 500);
        claim = null;
        return contextView(context);
      }
      if (context.installation.status === 'ready') {
        claim = null;
        return contextView(context, completedRow(context), true);
      }
      if (context.installation.status !== 'verifying' || !context.installation.currentJobId) {
        fail('installation_not_ready');
      }
      const row = claimRow(store.activationJob(context.installation.currentJobId), timestamp);
      return contextView(manifestContext(), row, row.authority_scope === authorityScope
        && row.idempotency_key === idempotencyKey);
    });
  }

  function begin(evidence) {
    return store.transaction(() => {
      const timestamp = now();
      const testedAt = providerEvidence(evidence, timestamp);
      let context = manifestContext();
      requireUsableOrganization(context);
      const prior = store.activationJobByRequest(organizationId, authorityScope, idempotencyKey);
      if (prior) {
        if (prior.runtime_key !== context.installation.runtimeKey
            || prior.manifest_revision !== context.installation.manifestRevision
            || prior.provider !== 'paycom' || prior.profile_id !== 'paycom-main') {
          fail('idempotency_conflict');
        }
        if (context.installation.status !== 'verifying' || context.installation.currentJobId !== prior.id) {
          fail('installation_operation_not_allowed');
        }
        const row = claimRow(prior, timestamp);
        return contextView(manifestContext(), row, true);
      }
      if (context.installation.status !== 'waiting_for_provider_auth'
          || context.installation.currentJobId !== null) fail('installation_operation_not_allowed');
      const setup = store.installationSetup(organizationId);
      if (setup?.workerId !== null && setup?.leaseExpiresAt > timestamp) {
        fail('installation_operation_in_progress');
      }
      if (store.runningActivationJob(organizationId)) fail('installation_operation_in_progress');
      installationTransition('waiting_for_provider_auth', 'verifying');
      const jobId = identifier(jobFactory());
      const nextRevision = context.installation.revision + 1;
      store.updateInstallationControl({
        organizationId,
        expectedStatus: 'waiting_for_provider_auth',
        expectedRevision: context.installation.revision,
        status: 'verifying',
        revision: nextRevision,
        currentJobId: jobId,
        timestamp,
      });
      const row = store.createActivationJob({
        id: jobId,
        organizationId,
        installationRevision: nextRevision,
        manifestRevision: context.installation.manifestRevision,
        runtimeKey: context.installation.runtimeKey,
        authorityScope,
        idempotencyKey,
        workerId,
        leaseExpiresAt: timestamp + leaseMs,
        providerTestedAt: testedAt,
        timestamp,
      });
      claim = Object.freeze({ id: row.id, fence: row.fence });
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId: null,
        organizationId,
        action: 'installation.activation.begin',
        targetType: 'installation_job',
        targetId: row.id,
        result: 'succeeded',
        timestamp,
      });
      context = manifestContext();
      return contextView(context, row);
    });
  }

  function claimedRow(jobId, timestamp) {
    if (!claim || claim.id !== jobId) fail('installation_operation_in_progress');
    const row = store.activationJob(jobId);
    if (!row || row.status !== 'running' || row.worker_id !== workerId || row.fence !== claim.fence
        || row.lease_expires_at <= timestamp) fail('installation_operation_in_progress');
    const control = store.installationControl(organizationId);
    if (!control || control.status !== 'verifying' || control.currentJobId !== jobId
        || control.runtimeKey !== row.runtime_key || control.manifestRevision !== row.manifest_revision
        || control.revision !== row.installation_revision) fail('installation_operation_in_progress');
    return { row, control };
  }

  function heartbeat() {
    return store.transaction(() => {
      const timestamp = now();
      if (!claim) fail('installation_operation_in_progress');
      const { row } = claimedRow(claim.id, timestamp);
      const renewed = store.renewActivationJob(
        row.id, workerId, row.fence, timestamp + leaseMs, timestamp,
      );
      claim = Object.freeze({ id: renewed.id, fence: renewed.fence });
      return contextView(manifestContext(), renewed, true);
    });
  }

  function commit(activation, activationAuthorityValue) {
    return store.transaction(() => {
      const timestamp = now();
      const jobId = activationAuthorityValue?.jobId;
      const { row, control } = claimedRow(jobId, timestamp);
      const context = manifestContext();
      requireUsableOrganization(context);
      const expectedJob = activationJobView(row);
      const suppliedJob = installationJob({ ...activation?.job, replayed: false });
      if (JSON.stringify(suppliedJob) !== JSON.stringify(expectedJob)) fail('installation_not_ready');
      const selected = serverInstallationActivation({
        manifest: activation?.manifest,
        job: expectedJob,
        readiness: activation?.readiness,
        evidence: activation?.evidence,
      }, {
        manifestAuthority: context.manifestAuthority,
        jobId: row.id,
      });
      const evidenceCapturedAt = Date.parse(selected.evidence.capturedAt);
      if (!Number.isSafeInteger(evidenceCapturedAt) || evidenceCapturedAt > timestamp + 60_000
          || timestamp - evidenceCapturedAt > MAX_ACTIVATION_EVIDENCE_AGE_MS) fail('installation_not_ready');
      if (activationAuthorityValue.jobId !== row.id
          || JSON.stringify(activationAuthorityValue.manifestAuthority) !== JSON.stringify(context.manifestAuthority)) {
        fail('installation_not_ready');
      }
      installationTransition('verifying', 'ready', {
        activation: {
          manifest: selected.manifest,
          job: expectedJob,
          readiness: selected.readiness,
          evidence: selected.evidence,
        },
        authority: { manifestAuthority: context.manifestAuthority, jobId: row.id },
      });
      const nextRevision = control.revision + 1;
      store.finishActivationJob(
        row.id, workerId, row.fence, 'succeeded', 'ready', nextRevision, null,
        selected.evidence, timestamp,
      );
      store.updateInstallationControl({
        organizationId,
        expectedStatus: 'verifying',
        expectedRevision: control.revision,
        status: 'ready',
        revision: nextRevision,
        currentJobId: row.id,
        timestamp,
      });
      if (context.organization.status === 'setup_required') {
        store.updateOrganizationStatus(organizationId, 'active', timestamp);
      }
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId: null,
        organizationId,
        action: 'installation.activation.ready',
        targetType: 'installation_job',
        targetId: row.id,
        result: 'succeeded',
        timestamp,
      });
      const installed = store.installationControl(organizationId);
      const finished = store.activationJob(row.id);
      const organization = store.organization(organizationId);
      if (installed?.status !== 'ready' || installed.revision !== nextRevision
          || installed.currentJobId !== row.id || finished?.status !== 'succeeded'
          || finished.installation_state !== 'ready' || finished.installation_revision !== nextRevision
          || finished.evidence_digest !== selected.evidence.evidenceDigest
          || organization?.status !== 'active') fail('installation_not_ready');
      claim = null;
      return Object.freeze({ state: installed.status, revision: installed.revision });
    });
  }

  function failActivation(jobIdValue, failureValue) {
    return store.transaction(() => {
      const timestamp = now();
      const jobId = identifier(jobIdValue);
      const failure = installationFailure(failureValue);
      const { row, control } = claimedRow(jobId, timestamp);
      installationTransition('verifying', 'failed');
      const nextRevision = control.revision + 1;
      store.finishActivationJob(
        row.id, workerId, row.fence, 'failed', 'failed', nextRevision, failure.code, null, timestamp,
      );
      store.updateInstallationControl({
        organizationId,
        expectedStatus: 'verifying',
        expectedRevision: control.revision,
        status: 'failed',
        revision: nextRevision,
        currentJobId: row.id,
        timestamp,
      });
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId: null,
        organizationId,
        action: 'installation.activation.fail',
        targetType: 'installation_job',
        targetId: row.id,
        result: 'succeeded',
        timestamp,
      });
      claim = null;
      return activationJobView(store.activationJob(row.id));
    });
  }

  function retryFailure() {
    return store.transaction(() => {
      const timestamp = now();
      const context = manifestContext();
      requireUsableOrganization(context);
      if (context.installation.status !== 'failed' || !context.installation.currentJobId) {
        fail('installation_operation_not_allowed');
      }
      const failedJob = store.activationJob(context.installation.currentJobId);
      if (!failedJob || failedJob.status !== 'failed' || failedJob.installation_state !== 'failed'
          || failedJob.runtime_key !== context.installation.runtimeKey
          || failedJob.manifest_revision !== context.installation.manifestRevision) {
        fail('installation_operation_not_allowed');
      }
      installationTransition('failed', 'provisioning');
      installationTransition('provisioning', 'waiting_for_provider_auth');
      const selected = store.updateInstallationControl({
        organizationId,
        expectedStatus: 'failed',
        expectedRevision: context.installation.revision,
        status: 'waiting_for_provider_auth',
        revision: context.installation.revision + 2,
        currentJobId: null,
        timestamp,
      });
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId: null,
        organizationId,
        action: 'installation.activation.retry',
        targetType: 'installation_job',
        targetId: failedJob.id,
        result: 'succeeded',
        timestamp,
      });
      claim = null;
      return contextView({ ...manifestContext(), installation: selected });
    });
  }

  function guardSetupMutation(mutation) {
    if (typeof mutation !== 'function') fail('runtime_boundary_violation', 500);
    const renew = () => store.transaction(() => {
      const timestamp = now();
      if (!setupClaim) fail('installation_operation_in_progress');
      const context = manifestContext();
      requireUsableOrganization(context);
      const control = context.installation;
      const setup = store.installationSetup(organizationId);
      if (control.status !== 'waiting_for_provider_auth' || control.currentJobId !== null
          || setup?.workerId !== workerId || setup?.fence !== setupClaim.fence
          || setup?.leaseExpiresAt <= timestamp) fail('installation_operation_in_progress');
      store.renewInstallationSetup(
        organizationId, workerId, setupClaim.fence, timestamp + setupLeaseMs, timestamp,
      );
      const renewed = store.installationSetup(organizationId);
      setupClaim = Object.freeze({ fence: renewed.fence });
      return control;
    });
    const before = renew();
    const result = mutation();
    if (result && typeof result.then === 'function') fail('runtime_boundary_violation', 500);
    const after = renew();
    if (after.revision !== before.revision || after.manifestRevision !== before.manifestRevision
        || after.runtimeKey !== before.runtimeKey) fail('installation_operation_in_progress');
    return result;
  }

  function beginSetup() {
    return store.transaction(() => {
      const timestamp = now();
      const context = manifestContext();
      requireUsableOrganization(context);
      const control = context.installation;
      const setup = store.installationSetup(organizationId);
      if (control.status !== 'waiting_for_provider_auth' || control.currentJobId !== null) {
        fail('installation_operation_not_allowed');
      }
      let selected;
      if (setup.workerId === workerId && setup.leaseExpiresAt > timestamp) {
        selected = store.renewInstallationSetup(
          organizationId, workerId, setup.fence, timestamp + setupLeaseMs, timestamp,
        );
      } else {
        if (setup.workerId !== null && setup.leaseExpiresAt > timestamp) {
          fail('installation_operation_in_progress');
        }
        selected = store.claimInstallationSetup(
          organizationId, workerId, setup.fence, timestamp + setupLeaseMs, timestamp,
        );
      }
      setupClaim = Object.freeze({ fence: store.installationSetup(organizationId).fence });
      return contextView({ ...context, installation: selected });
    });
  }

  function endSetup() {
    return store.transaction(() => {
      const timestamp = now();
      if (!setupClaim) fail('installation_operation_in_progress');
      const selected = store.releaseInstallationSetup(
        organizationId, workerId, setupClaim.fence, timestamp,
      );
      setupClaim = null;
      return contextView({ ...manifestContext(), installation: selected });
    });
  }

  return Object.freeze({
    peek,
    inspect,
    begin,
    heartbeat,
    commit,
    fail: failActivation,
    retry: retryFailure,
    beginSetup,
    endSetup,
    guard: guardSetupMutation,
  });
}

module.exports = {
  DEFAULT_ACTIVATION_LEASE_MS,
  DEFAULT_SETUP_LEASE_MS,
  MAX_PROVIDER_EVIDENCE_AGE_MS,
  DEFAULT_MANAGED_TEMPLATE_ID,
  DEFAULT_MANAGED_RELEASE_ID,
  activationJobView,
  createAccessInstallationActivationAuthority,
};
