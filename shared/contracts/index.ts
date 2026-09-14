export type Environment = 'production' | 'preview';
export type Role = 'owner' | 'manager' | 'member';
export type Permission = 'read' | 'collect' | 'connections' | 'settings' | 'members';
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
  role: Role | 'platform_owner';
}
export interface Membership {
  id: string;
  userId: string;
  dspId: string;
  email: string;
  name: string;
  role: Role;
}
export interface SessionView {
  user: User;
  csrf: string;
  dsps: DspSummary[];
  development: boolean;
  environment: Environment;
  release: string;
  standalone?: boolean;
  providerMode?: 'fixture' | 'native';
}
export interface DspView {
  profile?: DspProfile;
  dsp: Dsp;
  token: string;
  role: Role | 'platform_owner';
}
export interface Connection {
  provider: 'paycom';
  enabled: boolean;
  status: ConnectionStatus;
  error: string | null;
  updatedAt: string;
  lastVerifiedAt: string | null;
  accountLabel: string | null;
}
export interface Job {
  id: string;
  dspId: string;
  dspName: string;
  environment: Environment;
  kind: 'paycom.collect';
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
export interface ReleaseSummary {
  digest: string;
  version: string;
  createdAt: string;
  testedAt: string | null;
  production: boolean;
  preview: boolean;
  notes: string;
}
export interface PlatformHealth {
  environment: Environment;
  release: string;
  jobs: Record<string, number>;
  browsers: { active: number; capacity: number };
  dsps: number;
  email: boolean;
  providerMode: 'fixture' | 'native';
}
export interface ApiFailure {
  error: string;
  message: string;
}
