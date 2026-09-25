import type { DspView, Permission } from '../../../shared/contracts/index.js';
import { featureCatalog, grants } from './features.js';

// A permission of a feature the DSP lacks is held by nobody, owners included.
export const can = (view: DspView | undefined, permission: Permission) =>
  Boolean(
    view &&
    grants(view.features, permission) &&
    (view.role.owner || view.permissions.includes(permission)),
  );
/** The permissions of `stored` that exist in the DSP; the rest are kept but never shown. */
export const visiblePermissions = (view: DspView, stored: readonly Permission[]) =>
  stored.filter((permission) => grants(view.features, permission));

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
  ...featureCatalog
    .filter((feature) => feature.kind === 'page')
    .map((feature): [string, Permission[]] => [feature.label, feature.permissions]),
  ['Connections', ['connections.manage']],
  ['Team', ['members.invite', 'members.manage', 'roles.manage']],
  ['DSP', ['settings.manage']],
];
/** The sections the role sheet shows a DSP: those whose permissions exist in it. */
export const visiblePermissionGroups = (view: DspView) =>
  permissionGroups.filter(([, items]) => items.some((p) => grants(view.features, p)));
/** Granting the key includes its value, mirroring `IMPLIED` in `backend/src/roles.rs`. */
export const impliedPermissions: Partial<Record<Permission, Permission>> = {
  'timecard.manage': 'timecard.view',
  'uniforms.adjust': 'uniforms.view',
  'uniforms.manage': 'uniforms.view',
};
