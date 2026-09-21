import type { DspView, Permission } from '../../../shared/contracts/index.js';

export const can = (view: DspView | undefined, permission: Permission) =>
  Boolean(view && (view.role.owner || view.permissions.includes(permission)));

export const permissionLabels: Record<Permission, string> = {
  'uniforms.adjust': 'Adjust Uniform Inventory',
  'uniforms.manage': 'Manage Uniforms & Sizes',
  'timecard.view': 'View Timecard',
  'timecard.manage': 'Manage Timecard',
  'collections.run': 'Run Collections',
  'connections.manage': 'Manage Connections',
  'members.invite': 'Invite Members',
  'members.manage': 'Manage Members',
  'roles.manage': 'Manage Roles',
  'settings.manage': 'Manage DSP Settings',
};
