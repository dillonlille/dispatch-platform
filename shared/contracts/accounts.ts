import type { Narrow } from './narrow.js';
import type { Role as GeneratedRole } from './generated/Role';
import type { DspView as GeneratedDspView } from './generated/DspView';
export type { PublicUser as User } from './generated/PublicUser';
export type { Member as Membership } from './generated/Member';
export const permissions = [
  'uniforms.adjust',
  'uniforms.manage',
  'timecard.view',
  'timecard.manage',
  'collections.run',
  'connections.manage',
  'members.invite',
  'members.manage',
  'roles.manage',
  'settings.manage',
] as const;
export type Permission = (typeof permissions)[number];
/** `members` and `invitations` are counted by the role list only; a saved role has null. */
export type Role = Narrow<GeneratedRole, { permissions: Permission[] }>;
export type { DspSummary } from './generated/DspSummary';
export type { SessionResponse as SessionView } from './generated/SessionResponse';
type ViewRole = Pick<Role, 'id' | 'name' | 'owner'>;
export type DspView = Narrow<
  GeneratedDspView,
  { permissions: Permission[]; role: ViewRole; roles?: ViewRole[] }
>;
export type { DspProfile } from './generated/DspProfile';
