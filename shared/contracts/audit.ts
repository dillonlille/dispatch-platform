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
