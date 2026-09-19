import { dateFormatter } from '../../../../shared/date-format.js';
import type { AuditChange, AuditEvent, Permission } from '../../../../shared/contracts/index.js';
import { errorLabel } from '../../app/api.js';
import { elapsed, timeOfDay, title } from '../../lib/format.js';
import { permissionLabels } from '../../app/permissions.js';
import { paycomColumns } from '../../../../shared/paycom.js';

export const views = new Set(['dsp.view_opened', 'dsp.owner_view_opened']);

// A sentence is built from parts so the feed and the export share one wording.
type Part = string | { strong: string };
const strong = (value: string): Part => ({ strong: value });
const day = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? dateFormatter('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${value}T00:00:00Z`),
      )
    : value;
// Earlier schedule events stored the schedule's id where its name belongs.
const named = (kind: string, name: string | null | undefined): Part[] =>
  name && !/^schedule_[0-9a-f]+$/.test(name) ? [`the ${kind} `, strong(name)] : [`a ${kind}`];
const providers: Record<string, string> = { paycom: 'Paycom', cortex: 'Cortex' };

const phrases: Record<string, (event: AuditEvent) => Part[]> = {
  'member.invited': (e) => ['invited ', strong(e.target ?? 'a new member')],
  'member.joined': () => ['joined the team'],
  'member.role_changed': (e) =>
    e.target ? ['changed ', strong(e.target), '’s role'] : ['changed a member’s role'],
  'member.removed': (e) =>
    e.target ? ['removed ', strong(e.target), ' from the team'] : ['removed a member'],
  'invitation.revoked': (e) => ['revoked the invitation for ', strong(e.detail)],
  'role.created': (e) => ['created ', ...named('role', e.detail)],
  'role.updated': (e) => ['updated ', ...named('role', e.target ?? e.detail)],
  'role.deleted': (e) => ['deleted ', ...named('role', e.detail)],
  'collection.requested': (e) => [
    'started a Paycom collection',
    ...(e.detail ? [' for ', strong(day(e.detail))] : []),
  ],
  'collection.cancelled': () => ['cancelled a collection'],
  'cortex.collection.requested': () => ['started a Cortex meal break collection'],
  'meal_breaks.sync_requested': (e) => [
    'started a meal break sync',
    ...(e.detail ? [' for ', strong(day(e.detail))] : []),
  ],
  'schedule.created': (e) => ['created ', ...named('schedule', e.detail)],
  'schedule.updated': (e) => ['updated ', ...named('schedule', e.target ?? e.detail)],
  'schedule.toggled': (e) => {
    const enabled = e.changes.find((change) => change.field === 'enabled')?.to;
    const verb =
      enabled === 'true' ? 'turned on ' : enabled === 'false' ? 'turned off ' : 'toggled ';
    return [verb, ...named('schedule', e.detail)];
  },
  'schedule.deleted': (e) => ['deleted ', ...named('schedule', e.detail)],
  'connection.credentials_saved': (e) => [
    'saved ',
    strong(providers[e.detail] ?? title(e.detail || 'connection')),
    ' credentials',
  ],
  'connection.disabled': (e) => [
    'disconnected ',
    strong(providers[e.detail] ?? title(e.detail || 'a connection')),
  ],
  'connection.verification_submitted': (e) => [
    'submitted verification for ',
    strong(providers[e.detail] ?? title(e.detail || 'a connection')),
  ],
  'dsp.view_opened': () => ['opened this DSP'],
  'dsp.owner_view_opened': (e) => [
    'opened ',
    ...(support(e) ? ['this DSP'] : [strong(e.dspName ?? 'a DSP')]),
    ...(e.detail ? [' as ', strong(e.detail)] : []),
  ],
  'dsp.support_visibility_changed': (e) => [
    e.detail === 'shown' ? 'showed Platform support to ' : 'hid Platform support from ',
    strong(e.dspName ?? 'a DSP'),
  ],
  'dsp.settings_updated': () => ['updated DSP settings'],
  'dsp.profile_completed': () => ['completed the DSP profile'],
  'dsp.created': (e) => ['created ', strong(e.dspName ?? 'a DSP')],
  'dsp.removed': (e) => ['removed ', strong(e.dspName ?? 'a DSP')],
  'dsp.restored': (e) => ['restored ', strong(e.dspName ?? 'a DSP')],
  'dsp.suspended': (e) => ['suspended ', strong(e.dspName ?? 'a DSP')],
  'dsp.resumed': (e) => ['resumed ', strong(e.dspName ?? 'a DSP')],
  'paycom.settings_updated': () => ['updated Paycom settings'],
  'employees.links_updated': () => ['updated employee links'],
  'audit.exported': () => ['exported the audit log'],
  'account.signed_in': () => ['signed in'],
  'account.password_changed': () => ['changed their password'],
  'account.password_reset': () => ['reset their password'],
  'diagnostics.fixtures_loaded': () => ['loaded demo data'],
  'development.fixtures_loaded': () => ['loaded demo data'],
};
// Outcomes describe the work itself; whoever asked for it moves to the second line.
const outcomes: Record<string, string> = {
  'collection.completed': 'completed',
  'collection.failed': 'failed',
  'collection.retrying': 'failed',
};
// Outcomes and joins carry facts rather than edits; their sentences spell them out.
export const facts = new Set([
  'provider',
  'date',
  'duration',
  'attempt',
  'invitedBy',
  'linked',
  'separated',
  'automatic',
]);
const fact = (event: AuditEvent, field: string) =>
  event.changes.find((change) => change.field === field)?.to ?? '';
const collected: Record<string, string> = { paycom: 'Paycom', cortex: 'Meal break' };
function outcome(event: AuditEvent): Part[] {
  const attempt = event.action === 'collection.retrying' && fact(event, 'attempt');
  const result = attempt
    ? ` attempt ${attempt} ${outcomes[event.action]}`
    : ` ${outcomes[event.action]}`;
  if (event.target) return ['Scheduled collection ', strong(event.target), result];
  const provider = collected[fact(event, 'provider')];
  const date = fact(event, 'date');
  return [
    provider ? `${provider} collection` : 'Collection',
    ...(date ? [' for ', strong(day(date))] : []),
    result,
  ];
}
const failures: Record<string, (provider: string) => string> = {
  manual_verification_required: (p) => `${p} needs verification — sign-in was challenged`,
  verification_expired: () => 'Verification expired before it was completed',
  provider_timeout: (p) => `${p} took too long to respond`,
  connection_required: (p) => `${p} is not connected`,
  roster_not_complete: () => 'The roster was not complete yet',
  job_cancelled: () => 'The collection was cancelled',
  browser_unavailable: () => 'The collection browser was unavailable',
  browser_start_failed: () => 'The collection browser could not start',
  browser_lost: () => 'The collection browser stopped responding',
  browser_closed: () => 'The collection browser stopped responding',
  browser_command_timeout: () => 'The collection browser stopped responding',
};
// These sentences already say what `detail` holds.
export const spoken = new Set([
  'invitation.revoked',
  'role.created',
  'role.updated',
  'role.deleted',
  'collection.requested',
  'collection.failed',
  'collection.retrying',
  'meal_breaks.sync_requested',
  'schedule.created',
  'schedule.updated',
  'schedule.toggled',
  'schedule.deleted',
  'audit.exported',
  'connection.credentials_saved',
  'connection.disabled',
  'connection.verification_submitted',
  'dsp.owner_view_opened',
  'dsp.support_visibility_changed',
  'employees.links_updated',
  'paycom.settings_updated',
]);

const system = (event: AuditEvent) => !event.actorId && event.actorName === 'System';
// Inside a DSP the server names every platform owner this way.
export const support = (event: AuditEvent) =>
  !event.actorId && event.actorName === 'Platform support';
export function sentence(event: AuditEvent): Part[] {
  if (outcomes[event.action]) return outcome(event);
  const phrase = phrases[event.action]?.(event) ?? [title(event.action).toLowerCase()];
  return [views.has(event.action) ? event.actorName : strong(event.actorName), ' ', ...phrase];
}
export const plain = (parts: Part[]) =>
  parts.map((part) => (typeof part === 'string' ? part : part.strong)).join('');

export const fields: Record<string, string> = {
  role: 'Role',
  name: 'Name',
  timezone: 'Timezone',
  collection: 'Collects',
  cadence: 'Repeats',
  interval: 'Every',
  time: 'Time',
  enabled: 'Status',
  abbreviation: 'Abbreviation',
  station: 'Station',
  'paycom.automatic_sync': 'Automatic sync',
  'paycom.sync_interval_seconds': 'Sync every',
  'paycom.opening_page': 'Opening page',
  'paycom.rows_per_page': 'Rows per page',
  'paycom.name_order': 'Name order',
  'paycom.default_sort': 'Default sort',
  'paycom.department': 'Department',
  'paycom.station': 'Station',
  'paycom.columns': 'Columns',
  'paycom.driver_departments': 'Driver departments',
  'paycom.late_da_time': 'Late DA time',
  'paycom.late_da_departments': 'Late DA departments',
};
const clockTime = (value: string) => timeOfDay(`2000-01-01T${value}:00Z`, 'UTC');
const paycomValues: Record<string, string> = {
  true: 'On',
  false: 'Off',
  timecards: 'Timecards',
  'meal-breaks': 'Meal Breaks',
  employees: 'Employees',
  first_last: 'First Last',
  last_first: 'Last, First',
  employeeName: 'Name',
  condition: 'Punch status',
  inDay: 'Clock in',
};
const collections: Record<string, string> = {
  paycom: 'Paycom',
  meal_break: 'Meal breaks',
  both: 'Paycom and meal breaks',
};
export function changeValue(field: string, value: string) {
  if (field === 'permission') return permissionLabels[value as Permission] ?? title(value);
  if (field === 'enabled') return value === 'true' ? 'On' : 'Off';
  if (field === 'collection') return collections[value] ?? title(value);
  if (field === 'cadence') return title(value);
  if (field === 'interval') return `${value} min`;
  if (field === 'paycom.sync_interval_seconds' && Number(value))
    return `${Math.round(Number(value) / 60)} min`;
  if (field === 'paycom.late_da_time' && /^\d{2}:\d{2}$/.test(value)) return clockTime(value);
  if (field === 'paycom.columns')
    return value
      .split(', ')
      .map((column) => paycomColumns.find(([key]) => key === column)?.[1] ?? column)
      .join(', ');
  if (field.startsWith('paycom.')) return paycomValues[value] ?? value;
  if (field === 'time' && /^\d{2}:\d{2}$/.test(value)) return clockTime(value);
  return value;
}
export function changeText(change: AuditChange) {
  const value = (side: string | null) => (side === null ? '' : changeValue(change.field, side));
  if (change.field === 'permission')
    return change.to === null ? `− ${value(change.from)}` : `+ ${value(change.to)}`;
  const label = fields[change.field] ?? title(change.field);
  if (change.from === null) return `${label} ${value(change.to)}`;
  if (change.to === null) return `${label} ${value(change.from)} removed`;
  return `${label} ${value(change.from)} → ${value(change.to)}`;
}
export const failure = (event: AuditEvent) =>
  event.action.endsWith('.failed') || event.action === 'collection.retrying'
    ? (failures[event.detail]?.(providers[fact(event, 'provider')] ?? 'The provider') ??
      errorLabel(event.detail) ??
      (event.detail ? title(event.detail) : ''))
    : '';
// The second line: what changed, why it failed, or who asked.
export function notes(event: AuditEvent, platform: boolean): string[] {
  return [
    ...(platform && event.dspName && !views.has(event.action) && !event.action.startsWith('dsp.')
      ? [event.dspName]
      : []),
    ...(outcomes[event.action] && !system(event) ? [`Requested by ${event.actorName}`] : []),
    ...(event.action === 'collection.completed' && fact(event, 'duration')
      ? [elapsed(Number(fact(event, 'duration')))]
      : []),
    ...(event.action === 'audit.exported' && Number(event.detail)
      ? [
          `${Number(event.detail).toLocaleString('en-US')} ${event.detail === '1' ? 'event' : 'events'}`,
        ]
      : []),
    ...(event.action === 'collection.retrying' ? ['Retrying'] : []),
    ...(event.action === 'collection.failed' && Number.parseInt(fact(event, 'attempt')) > 1
      ? [`After ${Number.parseInt(fact(event, 'attempt'))} attempts`]
      : []),
    ...(fact(event, 'invitedBy') ? [`Invited by ${fact(event, 'invitedBy')}`] : []),
    ...(event.action === 'employees.links_updated' ? linked(event) : []),
  ];
}

// Link saves say how many drivers were linked, kept apart or handed back to
// automatic matching. Earlier ones kept only "Revision 3; 2 changes".
function linked(event: AuditEvent) {
  const parts = [
    [fact(event, 'linked'), 'linked'],
    [fact(event, 'separated'), 'kept separate'],
    [fact(event, 'automatic'), 'set to automatic'],
  ].flatMap(([count, label]) => (count ? [`${count} ${label}`] : []));
  if (parts.length) return parts;
  const count = Number(/(\d+) changes?$/.exec(event.detail)?.[1]);
  return count ? [`${count} ${count === 1 ? 'link' : 'links'} changed`] : [];
}
