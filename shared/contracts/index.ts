export type Environment = 'production' | 'preview';
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
export interface Role {
  id: string;
  name: string;
  owner: boolean;
  permissions: Permission[];
  members: number;
  invitations: number;
}
export type DspStatus = 'provisioning' | 'active' | 'suspended' | 'failed';
export type ConnectionStatus =
  | 'not_connected'
  | 'ready'
  | 'signing_in'
  | 'needs_verification'
  | 'error';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_verification'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  platformOwner: boolean;
}
export interface Dsp {
  id: string;
  name: string;
  environment: Environment;
  status: DspStatus;
  timezone: string;
  permanent: boolean;
  revision: number;
  createdAt: string;
}
export interface DspProfile {
  abbreviation: string;
  stationCode: string;
  setupRequired: boolean;
  removed: boolean;
}
export interface DspSummary extends Dsp {
  profile: DspProfile;
  ownerEmail: string | null;
  ownerStatus: 'active' | 'invited' | 'missing';
  paycom: ConnectionStatus;
  lastCollection: string | null;
  role: string | null;
}
export interface Membership {
  id: string;
  userId: string;
  dspId: string;
  email: string;
  name: string;
  role: string;
  roleId: string | null;
  owner: boolean;
  status: 'active' | 'idle' | 'offline';
}
export interface SessionView {
  user: User;
  csrf: string;
  dsps: DspSummary[];
  development: boolean;
  environment: Environment;
  release: string;
  providerMode?: 'fixture' | 'native';
}
export interface DspView {
  profile?: DspProfile;
  dsp: Dsp;
  token: string;
  role: Pick<Role, 'id' | 'name' | 'owner'>;
  permissions: Permission[];
}
export interface Connection {
  verificationSessionId?: string;
  provider: 'paycom' | 'cortex';
  enabled: boolean;
  status: ConnectionStatus;
  error: string | null;
  updatedAt: string;
  lastVerifiedAt: string | null;
  accountLabel: string | null;
}
export interface PageRead {
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
export interface Job {
  id: string;
  dspId: string;
  dspName: string;
  environment: Environment;
  kind: 'paycom.collect' | 'cortex.meal_breaks.collect';
  status: JobStatus;
  progress: number;
  message: string;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  release: string;
  actorId: string | null;
  metrics: JobMetrics[];
}
export interface Schedule {
  intervalSeconds?: number;
  enabled: boolean;
  localTime: string;
  timezone: string;
  nextRun: string | null;
}
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
}
export interface Workforce {
  employees: Employee[];
  timecards: Timecard[];
  collectedAt: string;
  from: string;
  to: string;
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
