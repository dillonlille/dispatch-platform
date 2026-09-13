'use strict';

const { serverInstallationManifest } = require('../../../shared/contracts/src');
const { AccessError, identifier } = require('./validation');
const { runtimeBackend } = require('../../runtime-deployment');

const DEFAULT_MANAGED_TEMPLATE_ID = 'isolated_dsp_v1';
const DEFAULT_MANAGED_RELEASE_ID = 'dispatch_current_1';
const CATALOG_IDENTIFIER_RE = /^[a-z][a-z0-9_.-]{2,95}$/;

function fail(code, statusCode = 409) {
  throw new AccessError(code, statusCode);
}

function managedInstallationContext(store, organizationIdValue, options = {}) {
  if (!store || typeof store.organization !== 'function' || typeof store.installationControl !== 'function'
      || typeof store.installationBackend !== 'function'
      || !options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['templateId', 'releaseId', 'backend'].includes(key))) {
    fail('runtime_boundary_violation', 500);
  }
  const organizationId = identifier(organizationIdValue);
  const templateId = options.templateId === undefined ? DEFAULT_MANAGED_TEMPLATE_ID : options.templateId;
  const organization = store.organization(organizationId);
  const installation = store.installationControl(organizationId);
  if (!organization || !installation) fail('installation_not_found', 404);
  const backend = runtimeBackend(store.installationBackend(organizationId));
  if (options.backend !== undefined && backend !== runtimeBackend(options.backend)) {
    fail('runtime_identity_mismatch');
  }
  if (installation.runtimeKey === 'local') fail('installation_operation_not_allowed');
  const releaseId = options.releaseId === undefined ? installation.releaseId : options.releaseId;
  if (!CATALOG_IDENTIFIER_RE.test(templateId) || !CATALOG_IDENTIFIER_RE.test(releaseId)) {
    fail('runtime_boundary_violation', 500);
  }
  const primary = organization.stations.find(station => station.primary);
  if (!primary) fail('runtime_boundary_violation', 500);
  const manifest = {
    manifestVersion: 1,
    revision: installation.manifestRevision,
    organization: {
      id: organization.id,
      stationCode: primary.code,
      timezone: organization.timezone,
    },
    runtime: {
      key: installation.runtimeKey,
      templateId,
      releaseId,
    },
  };
  const manifestAuthority = {
    revision: manifest.revision,
    organization: { ...manifest.organization },
    runtime: { ...manifest.runtime },
  };
  return Object.freeze({
    organization,
    installation,
    backend,
    manifest: serverInstallationManifest(manifest, manifestAuthority),
    manifestAuthority: Object.freeze(manifestAuthority),
    ownerActive: store.activeOwnerCount(organizationId) > 0,
  });
}

module.exports = {
  DEFAULT_MANAGED_TEMPLATE_ID,
  DEFAULT_MANAGED_RELEASE_ID,
  managedInstallationContext,
};
