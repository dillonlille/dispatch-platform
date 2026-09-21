import type { Narrow } from './narrow.js';
import type { Role as GeneratedRole } from './generated/Role';
import type { DspSummary as GeneratedDspSummary } from './generated/DspSummary';
import type { DspView as GeneratedDspView } from './generated/DspView';
import type { SessionResponse } from './generated/SessionResponse';
export type { PublicUser as User } from './generated/PublicUser';
export type { Member as Membership } from './generated/Member';
export const permissions = [
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
export type DspSummary = Narrow<GeneratedDspSummary, { profile: DspProfile }>;
export type SessionView = Narrow<SessionResponse, { dsps: DspSummary[] }>;
type ViewRole = Pick<Role, 'id' | 'name' | 'owner'>;
export type DspView = Narrow<
  GeneratedDspView,
  { profile: DspProfile; permissions: Permission[]; role: ViewRole; roles?: ViewRole[] }
>;
interface DspProfile {
  abbreviation: string;
  stationCode: string;
  setupRequired: boolean;
  removed: boolean;
  // Whether this DSP's audit log lists platform owners, as "Platform support".
  supportVisible: boolean;
}
