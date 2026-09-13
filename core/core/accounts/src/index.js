'use strict';

const { AccessStore } = require('./store');
const { AccessControlService } = require('./service');
const installationAuthority = require('./installation-authority');
const installationProvisioning = require('./installation-provisioning');
const installationActivation = require('./installation-activation');
const installationLifecycle = require('./installation-lifecycle');
const runtimeAgentAuthority = require('./runtime-agent-authority');
const validation = require('./validation');
const permissions = require('./permissions');
const passwords = require('./passwords');

module.exports = {
  AccessStore,
  AccessControlService,
  ...installationAuthority,
  ...installationProvisioning,
  ...installationActivation,
  ...installationLifecycle,
  ...runtimeAgentAuthority,
  ...validation,
  ...permissions,
  ...passwords,
};
