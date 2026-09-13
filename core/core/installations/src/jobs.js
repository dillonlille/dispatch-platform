'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { installationFailure, serverInstallationManifest } = require('../../../shared/contracts/src');
const { createInstallationLayoutManager } = require('./layout');
const { createInstallationServiceManager } = require('./services');
const { createSystemdUserSupervisor, DEFAULT_WAIT_TIMEOUT_MS } = require('./systemd-user');
const {
  INSTALLATION_JOB_STAGES,
  INSTALLATION_JOB_PIPELINE_ID,
  INSTALLATION_SERVICE_PIPELINE_ID,
  INSTALLATION_SERVICE_STAGES,
  INSTALLATION_OCI_PIPELINE_ID,
  INSTALLATION_NATIVE_PIPELINE_ID,
  INSTALLATION_OCI_STAGES,
  pipelineIdForBackend,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  createInstallationJobStore,
} = require('./job-store');

const DEFAULT_JOB_LEASE_MS = 30_000;
const SERVICE_HEALTH_LEASE_MARGIN_MS = 5_000;

function serviceHealthLeaseMs(plan, configuredLeaseMs) {
  return Math.min(MAX_LEASE_MS, Math.max(
    configuredLeaseMs,
    DEFAULT_WAIT_TIMEOUT_MS * plan.units.length + SERVICE_HEALTH_LEASE_MARGIN_MS,
  ));
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, allowed, required, code = 'runtime_boundary_violation') {
  if (!plain(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\0\r\n]/.test(value)) fail('runtime_boundary_violation');
  return value;
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function selectedTime(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('installation_operation_failed');
  return value;
}

function defaultJobId() {
  return `job_${crypto.randomUUID().replaceAll('-', '')}`;
}

function sanitizedCall(callback) {
  try { return callback(); }
  catch (error) {
    const failure = installationFailure(error);
    fail(failure.code);
  }
}

function createDurableInstallationProvisioner(options) {
  exact(
    options,
    [
      'stateRoot', 'installationsRoot', 'projectRoot', 'clock', 'idFactory', 'leaseMs',
      'unitRoot', 'supervisor', 'commandPath', 'systemdAnalyze', 'systemctl', 'systemdRuntimeOnly',
      'liveAuthorityResolver', 'runtimeAgentHubSocket',
      'ociAdapter',
    ],
    ['stateRoot', 'installationsRoot'],
  );
  const stateRoot = absolute(options.stateRoot);
  const installationsRoot = absolute(options.installationsRoot);
  const serviceMode = options.unitRoot !== undefined;
  const ociAdapter = options.ociAdapter === undefined ? null : options.ociAdapter;
  const unitRoot = serviceMode ? absolute(options.unitRoot) : null;
  if (overlaps(stateRoot, installationsRoot) || overlaps(installationsRoot, stateRoot)
      || unitRoot && [stateRoot, installationsRoot].some(root => overlaps(root, unitRoot) || overlaps(unitRoot, root))) {
    fail('runtime_boundary_violation');
  }
  if (serviceMode && options.runtimeAgentHubSocket === undefined) fail('runtime_boundary_violation');
  if (!serviceMode && [
    'supervisor', 'commandPath', 'systemdAnalyze', 'systemctl', 'systemdRuntimeOnly', 'runtimeAgentHubSocket',
  ]
    .some(key => options[key] !== undefined)) fail('runtime_boundary_violation');
  if (ociAdapter !== null && [
    'plan', 'reconcileHostAccount', 'reconcileImage', 'reconcileBridge', 'reconcileContainer',
    'verify', 'commit', 'rollback',
  ].some(method => typeof ociAdapter[method] !== 'function')) fail('runtime_boundary_violation');
  const clock = options.clock === undefined ? Date.now : options.clock;
  const idFactory = options.idFactory === undefined ? defaultJobId : options.idFactory;
  const leaseMs = options.leaseMs === undefined ? DEFAULT_JOB_LEASE_MS : options.leaseMs;
  const liveAuthorityResolver = options.liveAuthorityResolver === undefined ? null : options.liveAuthorityResolver;
  if (typeof clock !== 'function' || typeof idFactory !== 'function'
      || liveAuthorityResolver !== null && typeof liveAuthorityResolver !== 'function'
      || !Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    fail('runtime_boundary_violation');
  }
  const sharedOptions = options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot };
  const { layout, services, supervisor, store } = sanitizedCall(() => {
    const selectedLayout = createInstallationLayoutManager({ installationsRoot, ...sharedOptions });
    const selectedServices = serviceMode ? createInstallationServiceManager({
      unitRoot,
      ...sharedOptions,
      ...(options.commandPath === undefined ? {} : { commandPath: options.commandPath }),
      ...(options.systemdAnalyze === undefined ? {} : { systemdAnalyze: options.systemdAnalyze }),
      ...(options.runtimeAgentHubSocket === undefined ? {} : {
        runtimeAgentHubSocket: options.runtimeAgentHubSocket,
      }),
    }) : null;
    const selectedSupervisor = serviceMode ? (options.supervisor === undefined
      ? createSystemdUserSupervisor({
        ...(options.commandPath === undefined ? {} : { commandPath: options.commandPath }),
        ...(options.systemctl === undefined ? {} : { systemctl: options.systemctl }),
        ...(options.systemdRuntimeOnly === undefined ? {} : { runtimeOnly: options.systemdRuntimeOnly }),
      })
      : options.supervisor) : null;
    if (serviceMode) {
      const methods = [
        'snapshot', 'reload', 'enable', 'disable', 'start', 'stop', 'resetFailed',
        'restoreState', 'inspect', 'health',
      ];
      if (!selectedSupervisor || methods.some(method => typeof selectedSupervisor[method] !== 'function')) {
        fail('runtime_boundary_violation');
      }
    }
    return Object.freeze({
      layout: selectedLayout,
      services: selectedServices,
      supervisor: selectedSupervisor,
      store: createInstallationJobStore({
        stateRoot,
        clock,
        ...sharedOptions,
        ...(serviceMode ? { pipelineId: INSTALLATION_SERVICE_PIPELINE_ID } : {}),
      }),
    });
  });
  let closed = false;

  function assertOpen() {
    if (closed) fail('installation_operation_failed');
  }

  function registerFixture(manifest, authority, fixtureAuthority) {
    assertOpen();
    return sanitizedCall(() => store.registerFixture(
      manifest,
      authority,
      fixtureAuthority,
      selectedTime(clock),
    ));
  }

  function registerLive(manifest, authority, registrationAuthority) {
    assertOpen();
    return sanitizedCall(() => store.registerLive(
      manifest,
      authority,
      registrationAuthority,
      selectedTime(clock),
    ));
  }

  function request(manifest, authority, operation, requestAuthority, backendValue = null) {
    assertOpen();
    return sanitizedCall(() => {
      const jobId = idFactory();
      const pipelineId = backendValue === null ? undefined
        : backendValue === 'systemd_user' && !serviceMode ? INSTALLATION_JOB_PIPELINE_ID
          : pipelineIdForBackend(backendValue);
      return store.request(
        manifest,
        authority,
        operation,
        requestAuthority,
        jobId,
        selectedTime(clock),
        ...(pipelineId === undefined ? [] : [pipelineId]),
      );
    });
  }

  function authorizeLive(manifest, authority, requestAuthority, jobId, liveAuthority) {
    assertOpen();
    return sanitizedCall(() => store.authorizeLive(
      manifest,
      authority,
      requestAuthority,
      jobId,
      liveAuthority,
      selectedTime(clock),
    ));
  }

  function inspect(manifest, authority, requestAuthority) {
    assertOpen();
    return sanitizedCall(() => store.current(manifest, authority, requestAuthority));
  }

  function progress(manifest, authority, requestAuthority, jobId) {
    assertOpen();
    return sanitizedCall(() => store.progress(manifest, authority, requestAuthority, jobId));
  }

  function liveAuthorityRequest(current, claim) {
    return Object.freeze({
      organizationId: current.manifest.organization.id,
      runtimeKey: current.manifest.runtime.key,
      manifestRevision: current.manifest.revision,
      installationRevision: current.revision,
      jobId: claim.jobId,
    });
  }

  function validateLiveAuthority(authority, current, claim) {
    exact(authority,
      ['manifestAuthority', 'backend', 'organizationStatus', 'installationState', 'installationRevision', 'currentJobId'],
      ['manifestAuthority', 'backend', 'organizationStatus', 'installationState', 'installationRevision', 'currentJobId']);
    if (!['pending_owner', 'setup_required', 'active'].includes(authority.organizationStatus)
        || authority.installationState !== 'provisioning' || authority.currentJobId !== claim.jobId) {
      fail('installation_operation_in_progress');
    }
    if (authority.installationRevision !== current.revision) fail('installation_revision_conflict');
    if (authority.backend === 'oci_container_v1' && current.pipelineId !== INSTALLATION_OCI_PIPELINE_ID
        || authority.backend === 'native_service_v1' && current.pipelineId !== INSTALLATION_NATIVE_PIPELINE_ID
        || authority.backend === 'systemd_user' && ![
          INSTALLATION_JOB_PIPELINE_ID, INSTALLATION_SERVICE_PIPELINE_ID,
        ].includes(current.pipelineId)
        || !['oci_container_v1', 'native_service_v1', 'systemd_user'].includes(authority.backend)) {
      fail('runtime_identity_mismatch');
    }
    const manifest = serverInstallationManifest(current.manifest, authority.manifestAuthority);
    if (JSON.stringify(manifest) !== JSON.stringify(current.manifest)) fail('runtime_identity_mismatch');
    return authority;
  }

  function authoritativeCurrent(current, claim) {
    if (current.fixture) return current;
    if (liveAuthorityResolver === null) fail('installation_operation_not_allowed');
    const authority = validateLiveAuthority(
      liveAuthorityResolver(liveAuthorityRequest(current, claim)), current, claim);
    return Object.freeze({ ...current, authority: authority.manifestAuthority });
  }

  function authoritativeMutation(current, claim, mutation) {
    if (current.fixture) return mutation();
    if (liveAuthorityResolver === null) fail('installation_operation_not_allowed');
    let invoked = false;
    let result;
    const authority = liveAuthorityResolver(liveAuthorityRequest(current, claim), () => {
      if (invoked) fail('runtime_boundary_violation');
      invoked = true;
      result = mutation();
    });
    if (!invoked) fail('runtime_boundary_violation');
    validateLiveAuthority(authority, current, claim);
    return result;
  }

  function servicePlan(current) {
    if (!serviceMode || current.pipelineId !== INSTALLATION_SERVICE_PIPELINE_ID) {
      fail('runtime_boundary_violation');
    }
    const selectedLayout = layout.derive(current.manifest, current.authority);
    return services.plan(current.manifest, current.authority, selectedLayout);
  }

  function ociPlan(current, claim) {
    if (ociAdapter === null || ![INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId)) {
      fail('runtime_boundary_violation');
    }
    return ociAdapter.plan(current.manifest, current.authority, { fixture: current.fixture, claim });
  }

  let hostMutationDepth = 0;
  function mutationGuard(claim, current) {
    return mutation => store.mutateClaim(claim, selectedTime(clock),
      () => authoritativeMutation(current, claim, () => {
        hostMutationDepth += 1;
        try { return mutation(); } finally { hostMutationDepth -= 1; }
      }));
  }

  function dispatchHostRequest(request, dispatch) {
    const { authorizeHostRequest } = require('./oci-host-permissions');
    const claim = request.claim;
    const authorize = () => {
      const current = store.work(claim, selectedTime(clock));
      if (![INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId)
          || current.cancelRequested && !current.compensating) fail('installation_operation_not_allowed');
      const lease = authorizeHostRequest({ kind: 'provisioning', claim, manifest: current.manifest,
        backend: current.pipelineId === INSTALLATION_NATIVE_PIPELINE_ID ? 'native_service_v1' : 'oci_container_v1', stage: current.stage, compensation: current.compensating,
        operation: current.operation, installationRevision: current.revision, expiresAt: current.leaseExpiresAt }, request);
      return dispatch(lease);
    };
    if (hostMutationDepth) return authorize();
    const current = authoritativeCurrent(store.work(claim, selectedTime(clock)), claim);
    return mutationGuard(claim, current)(authorize);
  }

  function sameSupervisorState(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function rollbackServices(claim, current, removeCandidate) {
    if (!serviceMode || current.pipelineId !== INSTALLATION_SERVICE_PIPELINE_ID
        || current.completedStages < 2) return Object.freeze({ selected: null, journal: false });
    const selected = servicePlan(current);
    const prior = services.rollbackState(selected);
    const installCheckpoint = INSTALLATION_SERVICE_STAGES.indexOf('runtime_service_install') + 1;
    if (!prior && current.completedStages >= installCheckpoint) fail('service_installation_failed');
    if (prior) {
      const guard = mutationGuard(claim, current);
      supervisor.stop(selected, guard);
      supervisor.resetFailed(selected, mutationGuard(claim, current));
      supervisor.disable(selected, guard);
      services.restoreFiles(selected, mutationGuard(claim, current));
      supervisor.reload(selected, mutationGuard(claim, current));
      supervisor.restoreState(selected, prior, mutationGuard(claim, current));
      const restored = supervisor.snapshot(selected);
      if (!sameSupervisorState(restored, prior)) fail('service_installation_failed');
    }
    if (removeCandidate) services.removeCandidate(selected, mutationGuard(claim, current));
    return Object.freeze({ selected, journal: Boolean(prior) });
  }

  function rollbackOci(claim, current) {
    if (![INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId) || ociAdapter === null) {
      fail('runtime_boundary_violation');
    }
    return ociAdapter.rollback(current.manifest, current.authority, {
      fixture: current.fixture,
      intent: current.compensationIntent,
      claim,
    }, mutationGuard(claim, current));
  }

  function executeCompensation(claim, current) {
    try {
      if ([INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId)) rollbackOci(claim, current);
      else rollbackServices(claim, current, current.compensationIntent === 'cancelled');
    } catch (rollbackError) {
      if (rollbackError?.code === 'installation_operation_in_progress') throw rollbackError;
      return store.failCompensation(claim, selectedTime(clock));
    }
    return store.finishCompensation(claim, selectedTime(clock));
  }

  function finishAfterError(claim, error) {
    const now = selectedTime(clock);
    let current;
    try { current = authoritativeCurrent(store.work(claim, now), claim); }
    catch (stateError) {
      if (stateError?.code === 'installation_operation_in_progress') throw stateError;
      throw error;
    }
    const cancellation = current.cancelRequested;
    const requiresCompensation = (serviceMode && current.pipelineId === INSTALLATION_SERVICE_PIPELINE_ID
        && current.completedStages >= INSTALLATION_SERVICE_STAGES.indexOf('runtime_service_render'))
      || [INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId);
    if (requiresCompensation) {
      store.beginCompensation(
        claim,
        cancellation ? 'cancelled' : 'failed',
        error,
        selectedTime(clock),
      );
      return executeCompensation(claim,
        authoritativeCurrent(store.work(claim, selectedTime(clock)), claim));
    }
    if (cancellation) return store.finishCancelled(claim, selectedTime(clock));
    return store.finishFailed(claim, error, selectedTime(clock));
  }

  function runNext(workerId) {
    assertOpen();
    return sanitizedCall(() => {
      const claim = store.claimNext(workerId, selectedTime(clock), leaseMs);
      if (!claim) return Object.freeze({ ok: true, status: 'idle' });
      if (claim.terminalJob) return claim.terminalJob;
      try {
        for (;;) {
          const now = selectedTime(clock);
          const current = authoritativeCurrent(store.work(claim, now), claim);
          if (current.compensating) return executeCompensation(claim, current);
          if (current.cancelRequested) {
            return finishAfterError(claim, Object.assign(new Error('installation_operation_not_allowed'), {
              code: 'installation_operation_not_allowed',
            }));
          }
          if (current.stage === null) {
            store.renew(claim, now, [INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId) ? 600_000 : leaseMs);
            let selected = null;
            if ([INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId)) {
              selected = ociPlan(current, claim);
              ociAdapter.verify(selected, claim);
              ociAdapter.commit(selected, claim, mutationGuard(claim, current));
            } else {
              layout.inspect(current.manifest, current.authority);
            }
            if (current.pipelineId === INSTALLATION_SERVICE_PIPELINE_ID) {
              selected = servicePlan(current);
              if (!services.rollbackState(selected)) fail('service_installation_failed');
              services.inspectInstalled(selected);
              supervisor.inspect(selected);
              store.renew(claim, selectedTime(clock), serviceHealthLeaseMs(selected, leaseMs));
              supervisor.health(selected);
            }
            if (selected && current.pipelineId === INSTALLATION_SERVICE_PIPELINE_ID) {
              services.markVerified(selected, mutationGuard(claim, current));
            }
            const verifiedAt = selectedTime(clock);
            const finalState = authoritativeCurrent(store.work(claim, verifiedAt), claim);
            if (finalState.cancelRequested) {
              return finishAfterError(claim, Object.assign(new Error('installation_operation_not_allowed'), {
                code: 'installation_operation_not_allowed',
              }));
            }
            if (selected) {
              return store.finishSucceeded(claim, verifiedAt);
            }
            return store.finishSucceeded(claim, verifiedAt);
          }
          store.renew(claim, now, [INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(current.pipelineId) ? 600_000 : leaseMs);
          let receipt;
          if (current.stage === INSTALLATION_JOB_STAGES[0]) {
            receipt = layout.materialize(
              current.manifest,
              current.authority,
              mutationGuard(claim, current),
            );
          } else if (current.stage === INSTALLATION_JOB_STAGES[1]) {
            receipt = layout.inspect(current.manifest, current.authority);
          } else if (current.stage === INSTALLATION_SERVICE_STAGES[2]) {
            const selected = servicePlan(current);
            if (services.rollbackState(selected)) services.finalizeSettled(selected, mutationGuard(claim, current));
            receipt = services.render(selected, mutationGuard(claim, current));
          } else if (current.stage === INSTALLATION_SERVICE_STAGES[3]) {
            receipt = services.validate(servicePlan(current));
          } else if (current.stage === INSTALLATION_SERVICE_STAGES[4]) {
            const selected = servicePlan(current);
            if (services.rollbackState(selected)) fail('service_installation_failed');
            supervisor.reload(selected, mutationGuard(claim, current));
            receipt = services.install(selected, supervisor.snapshot(selected), mutationGuard(claim, current));
          } else if (current.stage === INSTALLATION_SERVICE_STAGES[5]) {
            const selected = servicePlan(current);
            if (!services.rollbackState(selected)) fail('service_installation_failed');
            supervisor.reload(selected, mutationGuard(claim, current));
            supervisor.enable(selected, mutationGuard(claim, current));
            receipt = supervisor.start(selected, mutationGuard(claim, current));
          } else if (current.stage === INSTALLATION_SERVICE_STAGES[6]) {
            const selected = servicePlan(current);
            if (!services.rollbackState(selected)) fail('service_installation_failed');
            services.inspectInstalled(selected);
            supervisor.inspect(selected);
            store.renew(claim, selectedTime(clock), serviceHealthLeaseMs(selected, leaseMs));
            receipt = supervisor.health(selected);
          } else if (current.stage === INSTALLATION_OCI_STAGES[0]) {
            receipt = ociAdapter.reconcileHostAccount(
              current.manifest,
              current.authority,
              { fixture: current.fixture, claim },
              mutationGuard(claim, current),
            );
          } else if (current.stage === INSTALLATION_OCI_STAGES[1]) {
            receipt = ociAdapter.reconcileImage(ociPlan(current, claim), claim, mutationGuard(claim, current));
          } else if (current.stage === INSTALLATION_OCI_STAGES[2]) {
            receipt = ociAdapter.reconcileBridge(ociPlan(current, claim), claim, mutationGuard(claim, current));
          } else if (current.stage === INSTALLATION_OCI_STAGES[3]) {
            receipt = ociAdapter.reconcileContainer(ociPlan(current, claim), claim, mutationGuard(claim, current));
          } else if (current.stage === INSTALLATION_OCI_STAGES[4]) {
            receipt = ociAdapter.verify(ociPlan(current, claim), claim);
          } else {
            fail('runtime_boundary_violation');
          }
          const completedAt = selectedTime(clock);
          const after = authoritativeCurrent(store.work(claim, completedAt), claim);
          if (after.cancelRequested) {
            return finishAfterError(claim, Object.assign(new Error('installation_operation_not_allowed'), {
              code: 'installation_operation_not_allowed',
            }));
          }
          store.completeStage(claim, current.stage, receipt, completedAt);
        }
      } catch (error) {
        return finishAfterError(claim, error);
      }
    });
  }

  function health() {
    assertOpen();
    return sanitizedCall(() => store.health());
  }

  function close() {
    if (closed) return;
    store.close();
    closed = true;
  }

  return Object.freeze({
    registerFixture,
    registerLive,
    request,
    authorizeLive,
    inspect,
    progress,
    runNext,
    dispatchHostRequest,
    health,
    close,
  });
}

module.exports = {
  DEFAULT_JOB_LEASE_MS,
  createDurableInstallationProvisioner,
};
