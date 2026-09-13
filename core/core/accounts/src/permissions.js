'use strict';

const TENANT_PERMISSIONS = Object.freeze([
  'dashboard.view',
  'workforce.read',
  'integrations.read',
  'sync.run',
  'members.read',
  'members.invite',
  'members.manage',
  'roles.read',
  'organization.settings.manage',
  'audit.read',
  'organization.owner',
]);

// Role labels are fixed; their permissions can be separated here later.
const SYSTEM_ROLES = Object.freeze([
  ['owner', 'Owner', 'DSP ownership'],
  ['manager', 'Manager', 'DSP team management'],
  ['dispatcher', 'Dispatcher', 'Dispatch operations'],
  ['driver', 'Driver', 'Delivery operations'],
].map(([key, name, description]) => Object.freeze({
  key, name, description, permissions: TENANT_PERMISSIONS,
})));

const PLATFORM_PERMISSIONS = Object.freeze([
  'platform.organizations.read',
  'platform.organizations.create',
  'platform.organizations.suspend',
  'platform.invitations.manage',
  'platform.installations.read',
  'platform.installations.manage',
]);

module.exports = {
  TENANT_PERMISSIONS,
  SYSTEM_ROLES,
  PLATFORM_PERMISSIONS,
};
