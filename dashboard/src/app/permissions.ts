import type { DspView, Permission } from '../../../shared/contracts/index.js';

export const can = (view: DspView | undefined, permission: Permission) =>
  Boolean(view && (view.role.owner || view.permissions.includes(permission)));
