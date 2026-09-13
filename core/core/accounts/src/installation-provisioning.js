'use strict';

const crypto = require('node:crypto');
const {
  INSTALLATION_IDENTIFIER_RE,
  installationFailure,
  installationJob,
  installationOperation,
  installationProvisioningRequest,
} = require('../../../shared/contracts/src');
const { AccessError, identifier } = require('./validation');
const {
  DEFAULT_MANAGED_TEMPLATE_ID,
  managedInstallationContext,
} = require('./installation-authority');

function fail(code, statusCode = 409) {
  throw new AccessError(code, statusCode);
}

function timestamp(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('installation_operation_failed', 500);
  return value;
}

function requestView(row, replayed = false) {
  if (!row) fail('installation_operation_not_found', 404);
  return installationProvisioningRequest({
    id: row.id,
    status: row.status,
    installationRevision: row.installation_revision,
    manifestRevision: row.manifest_revision,
    jobId: row.provisioner_job_id,
    replayed,
    failure: row.failure_code === null ? null : installationFailure(row.failure_code),
  });
}

function createAccessInstallationProvisioningAuthority(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => ![
        'store', 'organizationId', 'authorityScope', 'actorUserId', 'clock', 'requestFactory', 'backend',
      ].includes(key))
      || !options.store || typeof options.store.transaction !== 'function') {
    fail('runtime_boundary_violation', 500);
  }
  const store = options.store;
  const organizationId = identifier(options.organizationId);
  const authorityScope = identifier(options.authorityScope);
  const actorUserId = identifier(options.actorUserId);
  const clock = options.clock === undefined ? Date.now : options.clock;
  const requestFactory = options.requestFactory === undefined
    ? () => `prq_${crypto.randomUUID().replaceAll('-', '')}` : options.requestFactory;
  if (typeof clock !== 'function' || typeof requestFactory !== 'function') fail('runtime_boundary_violation', 500);
  const contextOptions = options.backend === undefined ? {} : { backend: options.backend };

  function request(operationValue) {
    const operation = installationOperation(operationValue);
    if (!['provision', 'retry'].includes(operation.operation)) fail('installation_operation_not_allowed');
    return store.transaction(() => {
      const at = timestamp(clock);
      const context = managedInstallationContext(store, organizationId, contextOptions);
      if (!['pending_owner', 'setup_required', 'active'].includes(context.organization.status)) {
        fail('installation_operation_not_allowed');
      }
      const id = identifier(requestFactory());
      const selected = store.createProvisioningRequest({
        id,
        organizationId,
        authorityScope,
        operation,
        timestamp: at,
      });
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId,
        organizationId,
        action: `installation.${operation.operation}.request`,
        targetType: 'installation_request',
        targetId: selected.row.id,
        result: 'succeeded',
        timestamp: at,
      });
      return requestView(selected.row, selected.replayed);
    });
  }

  function inspect(requestIdValue) {
    const requestId = identifier(requestIdValue);
    const row = store.provisioningRequest(requestId);
    if (!row || row.organization_id !== organizationId || row.authority_scope !== authorityScope) {
      fail('installation_operation_not_found', 404);
    }
    return requestView(row);
  }

  return Object.freeze({ request, inspect });
}

function createAccessControlLiveAuthorityResolver(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['store', 'templateId', 'releaseId', 'backend'].includes(key))
      || !options.store) fail('runtime_boundary_violation', 500);
  const store = options.store;
  const templateId = options.templateId === undefined ? DEFAULT_MANAGED_TEMPLATE_ID : options.templateId;
  const releaseId = options.releaseId;
  const backend = options.backend;
  return function resolve(request, mutation = null) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).sort().join(',') !== 'installationRevision,jobId,manifestRevision,organizationId,runtimeKey'
        || typeof request.organizationId !== 'string' || typeof request.runtimeKey !== 'string'
        || typeof request.jobId !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(request.organizationId)
        || !INSTALLATION_IDENTIFIER_RE.test(request.runtimeKey) || !INSTALLATION_IDENTIFIER_RE.test(request.jobId)
        || !Number.isSafeInteger(request.manifestRevision) || request.manifestRevision < 1
        || !Number.isSafeInteger(request.installationRevision) || request.installationRevision < 1
        || mutation !== null && typeof mutation !== 'function') {
      fail('runtime_boundary_violation', 500);
    }
    return store.transaction(() => {
      const read = () => {
        const context = managedInstallationContext(store, request.organizationId, {
          templateId, ...(releaseId === undefined ? {} : { releaseId }), ...(backend === undefined ? {} : { backend }),
        });
        if (!['pending_owner', 'setup_required', 'active'].includes(context.organization.status)
            || context.installation.status !== 'provisioning'
            || context.installation.currentJobId !== request.jobId
            || context.installation.runtimeKey !== request.runtimeKey
            || context.installation.revision !== request.installationRevision
            || context.installation.manifestRevision !== request.manifestRevision) {
          fail('installation_operation_in_progress');
        }
        return context;
      };
      const before = read();
      if (mutation !== null) mutation();
      const after = read();
      if (after.installation.revision !== before.installation.revision
          || JSON.stringify(after.manifest) !== JSON.stringify(before.manifest)) {
        fail('installation_operation_in_progress');
      }
      return Object.freeze({
        manifestAuthority: after.manifestAuthority,
        backend: after.backend,
        organizationStatus: after.organization.status,
        installationState: after.installation.status,
        installationRevision: after.installation.revision,
        currentJobId: after.installation.currentJobId,
      });
    });
  };
}

function createInstallationProvisioningReconciler(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => ![
        'store', 'provisioner', 'provisionerFactory', 'clock', 'templateId', 'releaseId',
        'runtimeAgentCredentials', 'runtimeAgentCredentialFactory', 'backend',
      ].includes(key))
      || !options.store || (options.provisioner === undefined) === (options.provisionerFactory === undefined)) {
    fail('runtime_boundary_violation', 500);
  }
  const store = options.store;
  const provisioner = options.provisioner === undefined ? null : options.provisioner;
  const provisionerFactory = options.provisionerFactory === undefined ? null : options.provisionerFactory;
  const required = ['registerLive', 'request', 'authorizeLive', 'inspect', 'runNext'];
  if ((provisioner !== null && required.some(method => typeof provisioner[method] !== 'function'))
      || (provisionerFactory !== null && typeof provisionerFactory !== 'function')) {
    fail('runtime_boundary_violation', 500);
  }
  const clock = options.clock === undefined ? Date.now : options.clock;
  const templateId = options.templateId === undefined ? DEFAULT_MANAGED_TEMPLATE_ID : options.templateId;
  const releaseId = options.releaseId;
  const backend = options.backend;
  const runtimeAgentCredentials = options.runtimeAgentCredentials === undefined
    ? null : options.runtimeAgentCredentials;
  const runtimeAgentCredentialFactory = options.runtimeAgentCredentialFactory === undefined
    ? null : options.runtimeAgentCredentialFactory;
  if (runtimeAgentCredentials !== null && runtimeAgentCredentialFactory !== null) {
    fail('runtime_boundary_violation', 500);
  }
  if (typeof clock !== 'function' || (runtimeAgentCredentialFactory !== null
      && typeof runtimeAgentCredentialFactory !== 'function') || (runtimeAgentCredentials !== null
      && (typeof runtimeAgentCredentials.issue !== 'function'
        || typeof runtimeAgentCredentials.revoke !== 'function'))) fail('runtime_boundary_violation', 500);

  function requestRow(requestIdValue) {
    const requestId = identifier(requestIdValue);
    const row = store.provisioningRequest(requestId);
    if (!row) fail('installation_operation_not_found', 404);
    return row;
  }

  function contextFor(row) {
    const context = managedInstallationContext(store, row.organization_id, {
      templateId, ...(releaseId === undefined ? {} : { releaseId }), ...(backend === undefined ? {} : { backend }),
    });
    if (context.backend === 'directory_service_v1') fail('installation_operation_not_allowed');
    if (context.installation.runtimeKey !== row.runtime_key
        || context.installation.manifestRevision !== row.manifest_revision) fail('runtime_identity_mismatch');
    return context;
  }

  function provisionerFor(context) {
    const selected = provisioner === null ? provisionerFactory(context.backend) : provisioner;
    if (!selected || required.some(method => typeof selected[method] !== 'function')) {
      fail('runtime_boundary_violation', 500);
    }
    return selected;
  }

  function credentialsFor(context) {
    const selected = runtimeAgentCredentialFactory === null
      ? runtimeAgentCredentials : runtimeAgentCredentialFactory(context.backend);
    if (selected !== null && (!selected || typeof selected.issue !== 'function'
        || typeof selected.revoke !== 'function')) fail('runtime_boundary_violation', 500);
    return selected;
  }

  function mutationAuthority(row) {
    return Object.freeze({
      scope: row.authority_scope,
      permission: 'platform.installations.manage',
      operatorEnabled: true,
    });
  }

  function dispatch(requestIdValue) {
    let row = requestRow(requestIdValue);
    if (row.status === 'completed' || row.status === 'failed') return requestView(row);
    let context = contextFor(row);
    let selectedProvisioner = provisionerFor(context);
    const operation = installationOperation(JSON.parse(row.request_json));
    const expectedStartingState = operation.operation === 'provision' ? 'pending'
      : operation.operation === 'retry' ? 'failed' : null;
    if (expectedStartingState === null || row.starting_state !== expectedStartingState
        || row.installation_revision !== operation.expectedRevision + 1) fail('runtime_boundary_violation', 500);
    const credentials = credentialsFor(context);
    if (credentials !== null) {
      let credential = null;
      try {
        store.transaction(() => {
          credential = credentials.issue(context.installation.runtimeKey);
          if (!credential || credential.runtimeKey !== context.installation.runtimeKey
              || !/^[a-f0-9]{64}$/.test(credential.tokenHash)
              || typeof credential.tokenChanged !== 'boolean') fail('runtime_boundary_violation', 500);
          store.recordRuntimeAgentAuthority({
            organizationId: row.organization_id,
            runtimeKey: row.runtime_key,
            tokenHash: credential.tokenHash,
            timestamp: timestamp(clock),
          });
        });
      } catch (error) {
        if (credential?.tokenChanged) {
          try { credentials.revoke(row.runtime_key, credential.tokenHash); } catch {}
        }
        throw error;
      }
    }
    if (operation.operation === 'provision') {
      selectedProvisioner.registerLive(context.manifest, context.manifestAuthority, {
        source: 'access_control',
        installationState: 'pending',
        organizationStatus: context.organization.status,
        retainedData: false,
      });
    }
    const job = installationJob(selectedProvisioner.request(
      context.manifest,
      context.manifestAuthority,
      operation,
      mutationAuthority(row),
      context.backend,
    ));
    store.transaction(() => {
      store.acknowledgeProvisioningRequest(row.id, job, timestamp(clock));
    });
    row = requestRow(row.id);
    context = contextFor(row);
    selectedProvisioner = provisionerFor(context);
    selectedProvisioner.authorizeLive(
      context.manifest,
      context.manifestAuthority,
      mutationAuthority(row),
      job.id,
      {
        source: 'access_control',
        installationState: 'provisioning',
        currentJobId: job.id,
        organizationStatus: context.organization.status,
      },
    );
    return requestView(requestRow(row.id));
  }

  function reconcile(requestIdValue) {
    let row = requestRow(requestIdValue);
    if (row.status === 'pending') dispatch(row.id);
    row = requestRow(row.id);
    if (row.status !== 'dispatched') return requestView(row);
    const context = contextFor(row);
    const job = installationJob(provisionerFor(context).inspect(
      context.manifest,
      context.manifestAuthority,
      { scope: row.authority_scope, permission: 'platform.installations.read' },
    ));
    if (!['succeeded', 'failed'].includes(job.status)) return requestView(row);
    store.transaction(() => {
      store.finishProvisioningRequest(row.id, job, timestamp(clock));
      require('./organization-profile').applyOrganizationProfiles(store, clock);
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId: null,
        organizationId: row.organization_id,
        action: 'installation.provision.reconcile',
        targetType: 'installation_request',
        targetId: row.id,
        result: job.status === 'succeeded' ? 'succeeded' : 'denied',
        timestamp: timestamp(clock),
      });
    });
    return requestView(requestRow(row.id));
  }

  function runNext(requestIdValue, workerIdValue) {
    const row = requestRow(requestIdValue);
    dispatch(row.id);
    provisionerFor(contextFor(requestRow(row.id))).runNext(identifier(workerIdValue));
    return reconcile(row.id);
  }

  function runPending(workerIdValue, limit = 20) {
    const workerId = identifier(workerIdValue);
    const rows = store.pendingProvisioningRequests(limit,
      require('../../runtime-deployment').RUNTIME_BACKENDS.filter(value => value !== 'directory_service_v1'));
    let processed = 0;
    for (const row of rows) {
      dispatch(row.id);
      const current = requestRow(row.id);
      const result = provisionerFor(contextFor(current)).runNext(workerId);
      if (result?.status !== 'idle') processed += 1;
    }
    const results = rows.map(row => reconcile(row.id));
    return Object.freeze({
      processed,
      completed: results.filter(result => result.status === 'completed').length,
      failed: results.filter(result => result.status === 'failed').length,
      pending: results.filter(result => ['pending', 'dispatched'].includes(result.status)).length,
    });
  }

  return Object.freeze({ dispatch, reconcile, runNext, runPending });
}

module.exports = {
  requestView,
  createAccessInstallationProvisioningAuthority,
  createAccessControlLiveAuthorityResolver,
  createInstallationProvisioningReconciler,
};
