import type { DspView, Role } from '../../../../shared/contracts/index.js';
import { can, visiblePermissions } from '../../app/permissions.js';

// Nobody hands out access they do not hold; the server enforces the same rule,
// both within the DSP's features.
export function assignable(view: DspView, role: Role) {
  return role.owner
    ? view.role.owner
    : visiblePermissions(view, role.permissions).every((p) => can(view, p));
}
