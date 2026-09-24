import type { DspView, Permission } from '../../../shared/contracts/index.js';

export const can = (view: DspView | undefined, permission: Permission) =>
  Boolean(view && (view.role.owner || view.permissions.includes(permission)));

export const permissionLabels: Record<Permission, string> = {
  'uniforms.view': 'View Uniform Inventory',
  'uniforms.adjust': 'Adjust Uniform Inventory',
  'uniforms.manage': 'Manage Uniform Inventory',
  'timecard.view': 'View Timecard',
  'timecard.manage': 'Manage Timecard',
  'collections.run': 'Run Collections',
  'connections.manage': 'Manage Connections',
  'members.invite': 'Invite Members',
  'members.manage': 'Manage Members',
  'roles.manage': 'Manage Roles',
  'settings.manage': 'Manage DSP Settings',
};
/** The role sheet's sections. Every permission in the catalog belongs to exactly one. */
export const permissionGroups: [string, Permission[]][] = [
  ['Timecard', ['timecard.view', 'timecard.manage']],
  ['Collections', ['collections.run']],
  ['Uniform Inventory', ['uniforms.view', 'uniforms.adjust', 'uniforms.manage']],
  ['Connections', ['connections.manage']],
  ['Team', ['members.invite', 'members.manage', 'roles.manage']],
  ['DSP', ['settings.manage']],
];
/** Granting the key includes its value, mirroring `IMPLIED` in `backend/src/roles.rs`. */
export const impliedPermissions: Partial<Record<Permission, Permission>> = {
  'timecard.manage': 'timecard.view',
  'uniforms.adjust': 'uniforms.view',
  'uniforms.manage': 'uniforms.view',
};
