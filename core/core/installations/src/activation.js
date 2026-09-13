'use strict';

const {
  INSTALLATION_IDENTIFIER_RE,
  INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
  INSTALLATION_READINESS_GATES,
  installationActivationEvidence,
  installationActivationEvidenceDigest,
  installationActivationResult,
  installationFailure,
  installationJob,
  installationReadiness,
  serverInstallationActivation,
  serverInstallationManifest,
} = require('../../../shared/contracts/src');
const {
  PAYCOM_PROFILE_ID,
  managedPaycomFirstPublicationRequest,
} = require('../../../shared/paycom-activation');

const ACTIVATION_INFRASTRUCTURE_GATES = Object.freeze([
  'runtime_layout',
  'service_supervision',
  'auth_broker',
  'collection_manager',
  'runtime_gateway',
]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, fields, code = 'installation_not_ready') {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail(code);
  return value;
}

function timestamp(value, code = 'installation_not_ready') {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(code);
  return value;
}

function authorityContext(value) {
  exact(value, ['manifest', 'manifestAuthority', 'installation', 'job', 'owner']);
  const manifest = serverInstallationManifest(value.manifest, value.manifestAuthority);
  exact(value.installation, ['state', 'revision', 'currentJobId']);
  if (!['waiting_for_provider_auth', 'verifying', 'ready'].includes(value.installation.state)
      || !Number.isSafeInteger(value.installation.revision) || value.installation.revision < 1
      || value.installation.currentJobId !== null
        && (typeof value.installation.currentJobId !== 'string'
          || !INSTALLATION_IDENTIFIER_RE.test(value.installation.currentJobId))) fail('installation_not_ready');
  exact(value.owner, ['active']);
  if (value.owner.active !== true) fail('installation_not_ready');
  let job = null;
  if (value.installation.state === 'verifying' || value.installation.state === 'ready') {
    job = installationJob(value.job);
    const expectedStatus = value.installation.state === 'ready' ? 'succeeded' : 'running';
    if (job.status !== expectedStatus || job.installationState !== value.installation.state
        || job.id !== value.installation.currentJobId) fail('installation_not_ready');
  } else if (value.job !== null || value.installation.currentJobId !== null) fail('installation_not_ready');
  return Object.freeze({
    manifest,
    manifestAuthority: value.manifestAuthority,
    installation: Object.freeze({ ...value.installation }),
    job,
    owner: Object.freeze({ active: true }),
  });
}

function infrastructureEvidence(value, runtimeKey) {
  exact(value, ['runtimeKey', ...ACTIVATION_INFRASTRUCTURE_GATES], 'runtime_health_failed');
  if (value.runtimeKey !== runtimeKey) fail('runtime_identity_mismatch');
  for (const gate of ACTIVATION_INFRASTRUCTURE_GATES) {
    if (value[gate] !== true) fail('runtime_health_failed');
  }
  return value;
}

function configurationEvidence(value, expectedDigest) {
  exact(value, ['digest', 'collectors', 'sources', 'plans', 'syncs'], 'runtime_health_failed');
  if (value.digest !== expectedDigest
      || value.collectors !== 1 || value.sources !== 1 || value.plans !== 15 || value.syncs !== 1) {
    fail('runtime_health_failed');
  }
  return value;
}

function providerEvidence(value) {
  exact(value, ['profileId', 'provider', 'status', 'testedAt'], 'provider_auth_required');
  if (value.profileId !== PAYCOM_PROFILE_ID || value.provider !== 'paycom' || value.status !== 'authenticated') {
    fail('provider_auth_required');
  }
  timestamp(value.testedAt, 'provider_auth_required');
  return Object.freeze({ ...value });
}

function publicationEvidence(value) {
  exact(value, ['batchId', 'preparationRunId', 'status', 'runCount', 'succeededRuns', 'failedRuns', 'cancelledRuns'],
    'first_publication_failed');
  if (typeof value.batchId !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value.batchId)
      || typeof value.preparationRunId !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value.preparationRunId)
      || value.status !== 'succeeded' || !Number.isSafeInteger(value.runCount) || value.runCount < 1
      || value.succeededRuns !== value.runCount || value.failedRuns !== 0 || value.cancelledRuns !== 0) {
    fail('first_publication_failed');
  }
  return Object.freeze({ ...value });
}

function readiness(context) {
  const gates = Object.fromEntries(INSTALLATION_READINESS_GATES.map(gate => [gate, 'passed']));
  return installationReadiness({
    manifestRevision: context.manifest.revision,
    jobId: context.job.id,
    runtimeKey: context.manifest.runtime.key,
    gates,
  });
}

function activationDependencies(value) {
  exact(value, ['authority', 'runtime', 'clock'], 'runtime_boundary_violation');
  const authority = value.authority;
  const runtime = value.runtime;
  if (!authority || !['inspect', 'begin', 'heartbeat', 'commit', 'fail']
    .every(method => typeof authority[method] === 'function')
      || !runtime || !['verifyInfrastructure', 'configure', 'testProvider', 'publishFirst', 'verifyPublication']
        .every(method => typeof runtime[method] === 'function')
      || typeof value.clock !== 'function') fail('runtime_boundary_violation');
  return value;
}

async function runManagedPaycomActivation(options) {
  const selected = activationDependencies({
    authority: options?.authority,
    runtime: options?.runtime,
    clock: options?.clock === undefined ? Date.now : options.clock,
  });
  let context = null;
  let committed = false;
  try {
    context = authorityContext(await selected.authority.inspect());
    if (context.installation.state === 'ready') {
      return installationActivationResult({
        ok: true,
        status: 'ready',
        state: 'ready',
        revision: context.installation.revision,
        manifestRevision: context.manifest.revision,
        gates: INSTALLATION_READINESS_GATES.length,
      });
    }
    const definition = options.definitionFactory ? options.definitionFactory(context) : null;
    infrastructureEvidence(await selected.runtime.verifyInfrastructure(context.manifest), context.manifest.runtime.key);

    if (context.installation.state === 'waiting_for_provider_auth') {
      const authenticated = providerEvidence(await selected.runtime.testProvider(PAYCOM_PROFILE_ID));
      context = authorityContext(await selected.authority.begin(authenticated));
    }
    const heartbeat = async () => {
      const current = authorityContext(await selected.authority.heartbeat());
      if (current.installation.state !== 'verifying' || current.job.id !== context.job.id
          || JSON.stringify(current.manifest) !== JSON.stringify(context.manifest)) {
        fail('installation_operation_in_progress');
      }
      context = current;
    };
    await heartbeat();
    const configured = await selected.runtime.configure(definition);
    const definitionDigest = definition ? definition.digest : configured?.digest;
    if (!/^[a-f0-9]{64}$/.test(definitionDigest || '')) fail('installation_not_ready');
    configurationEvidence(configured, definitionDigest);
    await heartbeat();
    infrastructureEvidence(await selected.runtime.verifyInfrastructure(context.manifest), context.manifest.runtime.key);
    await heartbeat();
    const request = managedPaycomFirstPublicationRequest();
    const batch = publicationEvidence(await selected.runtime.publishFirst(
      request,
      { idempotencyKey: `activation:${context.job.id}`, heartbeat },
    ));
    const audited = exact(await selected.runtime.verifyPublication(batch.batchId, batch.preparationRunId), [
      'definitionDigest', 'requestDigest', 'previewDigest', 'batchId', 'preparationRunId', 'target',
      'runs', 'publications', 'capturedAt',
    ], 'first_publication_failed');
    if (audited.definitionDigest !== definitionDigest) fail('first_publication_failed');
    const evidencePayload = {
      schemaVersion: INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
      manifestRevision: context.manifest.revision,
      jobId: context.job.id,
      runtimeKey: context.manifest.runtime.key,
      definitionDigest: audited.definitionDigest,
      requestDigest: audited.requestDigest,
      previewDigest: audited.previewDigest,
      batchId: audited.batchId,
      preparationRunId: audited.preparationRunId,
      target: audited.target,
      runs: audited.runs,
      publications: audited.publications,
      capturedAt: audited.capturedAt,
    };
    const evidence = installationActivationEvidence({
      ...evidencePayload,
      evidenceDigest: installationActivationEvidenceDigest(evidencePayload),
    });
    await heartbeat();
    infrastructureEvidence(await selected.runtime.verifyInfrastructure(context.manifest), context.manifest.runtime.key);
    await heartbeat();

    const current = authorityContext(await selected.authority.inspect());
    if (current.installation.state !== 'verifying' || current.job.id !== context.job.id
        || JSON.stringify(current.manifest) !== JSON.stringify(context.manifest)) fail('installation_not_ready');
    context = current;
    const report = readiness(context);
    const activation = Object.freeze({
      manifest: context.manifest,
      job: context.job,
      readiness: report,
      evidence,
    });
    const activationAuthority = Object.freeze({
      manifestAuthority: context.manifestAuthority,
      jobId: context.job.id,
    });
    serverInstallationActivation(activation, activationAuthority);
    const result = await selected.authority.commit(activation, activationAuthority);
    exact(result, ['state', 'revision'], 'installation_not_ready');
    if (result.state !== 'ready' || !Number.isSafeInteger(result.revision) || result.revision < 1) {
      fail('installation_not_ready');
    }
    committed = true;
    return installationActivationResult({
      ok: true,
      status: 'ready',
      state: result.state,
      revision: result.revision,
      manifestRevision: context.manifest.revision,
      gates: INSTALLATION_READINESS_GATES.length,
    });
  } catch (error) {
    const failure = installationFailure(error);
    if (context?.installation.state === 'verifying' && context.job && !committed
        && failure.code !== 'installation_operation_in_progress') {
      try { await selected.authority.fail(context.job.id, failure); } catch {}
    }
    return installationActivationResult({
      ok: false,
      status: failure.code,
      failure,
    });
  }
}

module.exports = {
  ACTIVATION_INFRASTRUCTURE_GATES,
  authorityContext,
  infrastructureEvidence,
  configurationEvidence,
  providerEvidence,
  publicationEvidence,
  readiness,
  runManagedPaycomActivation,
};
