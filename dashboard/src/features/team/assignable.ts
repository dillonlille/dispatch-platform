import type { DspView, Role } from '../../../../shared/contracts/index.js';
import { can } from '../../app/permissions.js';

// Nobody hands out access they do not hold; the server enforces the same rule.
export function assignable(view: DspView, role: Role) {
  return role.owner ? view.role.owner : role.permissions.every((p) => can(view, p));
}
