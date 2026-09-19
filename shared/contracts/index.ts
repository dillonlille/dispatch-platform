// Shapes the backend answers with are generated from its Rust types into `./generated`
// (`npm run contracts:generate`); this file gives them their dashboard names and narrows
// the fields Rust keeps as plain text or JSON. Everything else here is still hand-written.
import type { CollectionSchedule as GeneratedSchedule } from './generated/CollectionSchedule';
import type { CollectionSchedules as GeneratedSchedules } from './generated/CollectionSchedules';
import type { Connection as GeneratedConnection } from './generated/Connection';
import type { DspSummary as GeneratedDspSummary } from './generated/DspSummary';
import type { DspView as GeneratedDspView } from './generated/DspView';
import type { Environment } from './generated/Environment';
import type { PublicJob } from './generated/PublicJob';
import type { Role as GeneratedRole } from './generated/Role';
import type { SessionResponse } from './generated/SessionResponse';

export type { PublicUser as User } from './generated/PublicUser';
export type { Member as Membership } from './generated/Member';
export type { SchedulePreview } from './generated/SchedulePreview';
// A generated shape with some fields given the narrower type the backend really sends.
// The narrower type must fit the generated one, so a renamed or retyped field fails here.
type Narrow<T, N extends { [K in keyof N]: K extends keyof T ? T[K] : never }> = Omit<T, keyof N> &
  N;
export const permissions = [
  'timecard.view',
  'timecard.manage',
  'collections.run',
  'connections.manage',
  'members.invite',
  'members.manage',
  'roles.manage',
  'settings.manage',
  'audit.view',
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
export type Connection = Narrow<GeneratedConnection, { provider: 'paycom' | 'cortex' }>;
export type CollectionSchedule = GeneratedSchedule;
export type CollectionSchedules = GeneratedSchedules;
interface DspProfile {
  abbreviation: string;
  stationCode: string;
  setupRequired: boolean;
  removed: boolean;
  // Whether this DSP's audit log lists platform owners, as "Platform support".
  supportVisible: boolean;
}
interface PageRead {
  ordinal: number;
  attempt: number;
  stage: 'navigation' | 'content' | 'extraction';
  elapsedMs: number;
  navigationMs: number;
  contentMs: number;
  extractionMs: number;
  error: string | null;
  pendingRequests?: number | null;
  documentState?: 'loading' | 'interactive' | 'complete' | null;
}
export interface JobMetrics {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error: string | null;
  phase: 'starting' | 'authentication' | 'verification' | 'collection' | 'publication' | null;
  detail?: string | null;
  queueMs: number;
  elapsedMs: number;
  authenticationMs: number | null;
  verificationMs: number | null;
  collectionMs: number | null;
  publicationMs: number | null;
  employees: number | null;
  timecards: number | null;
  itineraries?: number | null;
  meals?: number | null;
  peakRssBytes: number | null;
  peakPssBytes: number | null;
  peakPrivateBytes: number | null;
  memorySamples: number;
  incompleteMemorySamples: number;
  pageReads?: {
    completed: number;
    retries: number;
    recovered: number;
    resumed?: number;
    earlyReady?: number;
    direct?: number;
    spotChecked?: number;
    totalMs: number;
    active: PageRead[];
    slowest: PageRead[];
    failures: PageRead[];
  };
}
export type Job = Narrow<PublicJob, { metrics: JobMetrics[] }>;
export interface Employee {
  code: string;
  name: string;
  department: string;
  position: string;
  station: string;
  active: boolean;
}
export interface Punch {
  inKind?: 'IN DAY' | 'IN LUNCH' | null;
  outKind?: 'OUT LUNCH' | 'OUT DAY' | null;
  in: string | null;
  out: string | null;
  hours: number | null;
}
export interface Timecard {
  employeeCode: string;
  date: string;
  hours: number;
  status: string;
  punches: Punch[];
  // The employee's Paycom timecard page for the pay period containing `date`.
  // Absent on rows still being collected; null before links were retained.
  sourceUrl?: string | null;
}
export interface AuditEvent {
  id: number;
  at: string;
  actorId: string | null;
  actorName: string;
  dspId: string | null;
  dspName: string | null;
  action: string;
  detail: string;
  area: AuditArea;
  target: string | null;
  // The record the event is about, when it has one that outlives a rename.
  ref: { kind: 'member' | 'role' | 'schedule' | 'job'; id: string } | null;
  changes: AuditChange[];
}
export type AuditArea =
  | 'team'
  | 'roles'
  | 'collections'
  | 'schedules'
  | 'connections'
  | 'access'
  | 'dsps'
  | 'settings';
// A changed field; a granted value has no `from` and a revoked one has no `to`.
export interface AuditChange {
  field: string;
  from: string | null;
  to: string | null;
}
export interface AuditPage {
  events: AuditEvent[];
  total: number;
  counts: Partial<Record<AuditArea | 'failures', number>>;
  actors: { id: string; name: string }[];
  // DSPs with activity, for narrowing the platform's log; empty inside a DSP.
  dsps: { id: string; name: string }[];
}
export interface PlatformHealth {
  environment: Environment;
  release: string;
  jobs: Record<string, number>;
  browsers: {
    active: number;
    capacity: number;
    memory: { availableBytes: number | null; requiredBytes: number; canStart: boolean };
  };
  dsps: number;
  email: boolean;
  mail: {
    enabled: boolean;
    pending: number;
    failed: number;
    oldestPendingAgeMs: number | null;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    transport: { error: string | null; checkedAt: string | null };
  };
  providerMode: 'fixture' | 'native';
}
