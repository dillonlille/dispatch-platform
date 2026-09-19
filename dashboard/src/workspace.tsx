import { useUpdateState } from './browser-update.js';
import { useState } from 'react';
import {
  Wrench,
  ArrowRight,
  RefreshCw,
  Plus,
  Ellipsis,
  Settings,
  AlertTriangle,
} from 'lucide-react';
import type { Connection, DspView, Membership, Job, Role } from '../../shared/contracts/index.js';
import { paycomDefaults, type PaycomSettings } from '../../shared/paycom.js';
import { api, useData } from './api.js';
import {
  Badge,
  ConfirmDialog,
  DataState,
  Empty,
  ErrorBox,
  Header,
  Loading,
  Modal,
  SearchInput,
  Tabs,
} from './ui/index.js';
import { time, timeOfDay, title } from './lib/format.js';
import { can } from './app/permissions.js';
import { EmployeesPage, TimecardsPage } from './dsp.js';
import { MealBreaksPage } from './meal-breaks.js';
import { usePaycomDate } from './paycom-day-controls.js';
import { localDate } from '../../shared/meal-breaks.js';
import { useAction } from './lib/useAction.js';
import { dspHash, navigate } from './app/navigation.js';
import { RoleSheet, RolesTab, assignable } from './roles.js';

export function HomePage() {
  return (
    <section className="dsp-home" aria-labelledby="dsp-home-heading">
      <div className="dsp-home-notice">
        <div className="dsp-home-icon" aria-hidden="true">
          <Wrench />
        </div>
        <h1 id="dsp-home-heading">Currently under development</h1>
        <p>We’re building your DSP home page.</p>
      </div>
    </section>
  );
}

type SyncSource = {
  enabled: boolean;
  active: boolean;
  job: Job | null;
  collectedAt: string | null;
};

function SourceSyncStatus({
  name,
  source,
  timezone,
  compact = false,
}: {
  name: string;
  source?: SyncSource;
  timezone: string;
  compact?: boolean;
}) {
  const status = source?.job?.status;
  const message = !source
    ? 'Checking…'
    : status === 'failed'
      ? 'Last collection failed'
      : status === 'cancelled'
        ? 'Sync cancelled'
        : source.active
          ? title(status ?? 'running')
          : !source.enabled
            ? 'Sync paused'
            : status === 'succeeded'
              ? 'Sync complete'
              : 'Waiting for next sync';
  if (compact) {
    const collectedAt = source?.collectedAt;
    const collectedToday =
      collectedAt && localDate(timezone, new Date(collectedAt)) === localDate(timezone);
    const timestamp = collectedAt
      ? collectedToday
        ? timeOfDay(collectedAt, timezone)
        : time(collectedAt, timezone)
      : null;
    return (
      <div
        className="paycom-header-sync"
        role="status"
        aria-label={`${name} sync`}
        title={collectedAt ? `Last successful sync ${time(collectedAt, timezone)}` : undefined}
      >
        {status === 'failed' && !source?.active ? (
          <span className="paycom-sync-failed">
            <AlertTriangle size={15} aria-hidden="true" />
            {name} failed
          </span>
        ) : (
          <Badge
            value={
              message === 'Sync complete'
                ? 'succeeded'
                : source?.active
                  ? (status ?? 'running')
                  : 'pending'
            }
          >
            {name} {message === 'Sync complete' ? 'synced' : message.toLowerCase()}
          </Badge>
        )}
        {collectedAt && message === 'Sync complete' && (
          <span className="paycom-sync-timestamp">
            ·{' '}
            <time
              dateTime={collectedAt}
              title={`Last successful sync ${time(collectedAt, timezone)}`}
            >
              {timestamp}
            </time>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="paycom-source-status">
      <span className="muted">{name}</span>
      <span role="status" aria-label={`${name} sync`}>
        {message}
      </span>
      {source?.collectedAt && (
        <span className="muted">Last successful sync {time(source.collectedAt, timezone)}</span>
      )}
    </div>
  );
}

export function PaycomPage({ view }: { view: DspView }) {
  const canCollect = can(view, 'collections.run');
  const [selectedTab, setTab] = useUpdateState<string | undefined>('paycom-tab', undefined);
  const { date, today, selectDate } = usePaycomDate(view.dsp.id, view.dsp.timezone);
  const preferences = useData<PaycomSettings>('/api/dsp/paycom/settings');
  const tab = selectedTab ?? 'timecards';
  const overview = useData<{
    connection: Connection;
    workforce: { collectedAt: string | null };
  }>('/api/dsp/paycom/status', 5000);
  const syncState = useData<{
    date: string;
    scopeAvailable: boolean;
    paycom: SyncSource;
    flex: SyncSource;
  }>(`/api/dsp/jobs/meal-breaks?date=${date}`, 5000);
  // The last known state stays up while another date loads so the page does not shift.
  const sourceState = syncState.data;
  const sourceCurrent = sourceState?.date === date;
  const { error, refresh } = overview;
  const data = overview.data?.connection;
  const meals = tab === 'meal-breaks';
  const timecards = tab === 'timecards';
  const daily = timecards || meals;
  const activeSync = sourceState?.paycom.active || (daily && sourceState?.flex.active);
  const collectedAt = overview.data?.workforce.collectedAt;
  const refreshKey = `${sourceState?.paycom.collectedAt ?? collectedAt}:${sourceState?.flex.collectedAt}`;
  const syncUnavailable = daily
    ? !sourceState
      ? 'Checking connections…'
      : !sourceState.paycom.enabled
        ? 'Connect Paycom in Settings → Connections to sync.'
        : !sourceState.flex.enabled
          ? 'Connect Cortex in Settings → Connections to sync Flex.'
          : !sourceState.scopeAvailable
            ? 'Complete your DSP profile with a station code to sync Flex.'
            : ''
    : !data?.enabled
      ? 'Connect Paycom to sync.'
      : '';
  const canConnect = can(view, 'connections.manage');
  const sync = useAction(
    async () => {
      await api(daily ? '/api/dsp/jobs/meal-breaks' : '/api/dsp/jobs', {
        requestId: crypto.randomUUID(),
        ...(tab !== 'employees' ? { date } : {}),
      });
      refresh();
      syncState.refresh();
    },
    { success: () => (daily ? 'Flex and Paycom collections queued' : 'Paycom collection queued') },
  );
  const syncButton = canCollect && (
    <button
      disabled={
        !!syncUnavailable ||
        !!syncState.error ||
        sync.busy ||
        !!activeSync ||
        (daily && !sourceCurrent)
      }
      title={
        syncUnavailable ||
        (daily ? `Sync Flex and Paycom for ${date}` : 'Sync Paycom’s current pay period')
      }
      onClick={() => void sync.run()}
    >
      <RefreshCw size={16} />
      Sync now
    </button>
  );
  return (
    <div className={`paycom-page${daily ? ' paycom-daily-page' : ''}`}>
      <Header title="Timecard">
        {daily && canCollect && (
          <>
            <SourceSyncStatus
              name="Paycom"
              source={sourceState?.paycom}
              timezone={view.dsp.timezone}
              compact
            />
            <SourceSyncStatus
              name="Flex"
              source={sourceState?.flex}
              timezone={view.dsp.timezone}
              compact
            />
          </>
        )}
        {daily && syncButton}
        {can(view, 'timecard.manage') && (
          <button onClick={() => navigate(dspHash(view.dsp.id, 'paycom-settings'))}>
            {daily && <Settings size={16} />}
            Settings
          </button>
        )}
      </Header>
      {canConnect && <ErrorBox message={error} />}
      {canCollect && <ErrorBox message={syncState.error} />}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['timecards', 'Timecard'],
          ['meal-breaks', 'Meal Breaks'],
          ['employees', 'Employees'],
        ]}
        label="Timecard"
      />
      {!daily && (
        <section className="paycom-workspace-controls" aria-label="Date and sync">
          <div className="paycom-controls-row">{syncButton}</div>
          {canCollect && (
            <div className="paycom-sync-status">
              <SourceSyncStatus
                name="Paycom"
                source={sourceState?.paycom}
                timezone={view.dsp.timezone}
              />
              {syncUnavailable && <span className="muted">{syncUnavailable}</span>}
            </div>
          )}
        </section>
      )}
      {daily && canCollect && syncUnavailable && (
        <p className="paycom-sync-unavailable muted">{syncUnavailable}</p>
      )}
      {tab === 'meal-breaks' ? (
        <MealBreaksPage
          date={date}
          today={today}
          onDateChange={selectDate}
          refreshKey={refreshKey}
          timezone={view.dsp.timezone}
          owner={can(view, 'timecard.manage')}
          preferences={preferences.data?.values ?? paycomDefaults}
        />
      ) : canConnect && !data && !error ? (
        <Loading />
      ) : canConnect && data && !data.enabled && !overview.data?.workforce.collectedAt ? (
        <button
          className="primary paycom-connect"
          onClick={() => navigate(dspHash(view.dsp.id, 'settings', { tab: 'connections' }))}
        >
          Connect Paycom
          <ArrowRight size={16} />
        </button>
      ) : (
        <div className="embedded-page">
          {tab === 'employees' ? (
            <EmployeesPage />
          ) : (
            <TimecardsPage
              date={date}
              onDateChange={selectDate}
              refreshKey={refreshKey}
              timezone={view.dsp.timezone}
              preferences={preferences.data?.values ?? paycomDefaults}
            />
          )}
        </div>
      )}
    </div>
  );
}

type Invitation = { email: string; role: string; expiresAt: number; accepted: boolean };
export function TeamPage({ view, reopen }: { view: DspView; reopen: () => Promise<void> }) {
  const { data, error, refresh } = useData<Membership[]>('/api/dsp/members', 10000);
  const canInvite = can(view, 'members.invite'),
    canManage = can(view, 'members.manage'),
    canRoles = can(view, 'roles.manage');
  const invitations = useData<Invitation[]>(canInvite ? '/api/dsp/invitations' : '', 10000);
  const roles = useData<Role[]>('/api/dsp/roles', 10000);
  const [roleEditor, setRoleEditor] = useState<Role | 'new'>();
  const grantable = roles.data?.filter((role) => assignable(view, role)) ?? [];
  const [tab, setTab] = useState('members');
  const [search, setSearch] = useState('');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Membership>();
  const [removing, setRemoving] = useState(false);
  const [revoking, setRevoking] = useState<Invitation>();
  const revoke = useAction(
    async (invitation: Invitation) => {
      await api('/api/dsp/invitations/revoke', { email: invitation.email });
      setRevoking(undefined);
      invitations.refresh();
    },
    { success: 'Invitation revoked' },
  );
  const invite = useAction(
    async (form: FormData) => {
      await api('/api/dsp/members/invite', { email: form.get('email'), role: form.get('role') });
      setInviting(false);
      invitations.refresh();
      roles.refresh();
    },
    { success: (form) => `Invitation email queued for ${form.get('email')}` },
  );
  // A null role removes the member.
  const assign = useAction(
    async (member: Membership, role: FormDataEntryValue | null) => {
      await api(`/api/dsp/members/${member.id}`, { role });
      setEditing(undefined);
      await reopen();
      refresh();
    },
    { success: (_, role) => (role === null ? 'Member removed' : 'Role updated') },
  );
  const members =
    data?.filter((member) =>
      `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Header title="Team & Roles">
        {tab === 'roles' && canRoles ? (
          <button className="primary" onClick={() => setRoleEditor('new')}>
            <Plus size={16} />
            Create role
          </button>
        ) : (
          canInvite && (
            <button className="primary" onClick={() => setInviting(true)}>
              <Plus size={16} />
              Invite member
            </button>
          )
        )}
      </Header>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['members', 'Members'],
          ['roles', 'Roles'],
          ...(canInvite ? [['invitations', 'Invitations']] : []),
        ]}
        label="Team"
      />
      <ErrorBox message={error || roles.error || invitations.error} />
      {tab === 'members' && (
        <>
          <div className="table-toolbar">
            <SearchInput
              label="Search members"
              placeholder="Search members"
              value={search}
              onChange={setSearch}
            />
            <button className="icon-button" aria-label="Refresh members" onClick={refresh}>
              <RefreshCw size={16} />
            </button>
          </div>
          <DataState data={data}>
            {() => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '45%' }}>Member</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => (
                      <tr key={member.id}>
                        <td>
                          <div className="member-identity">
                            <span className="avatar">
                              {member.name
                                .split(/\s+/)
                                .slice(0, 2)
                                .map((part) => part[0])
                                .join('')}
                            </span>
                            <div>
                              <strong>{member.name}</strong>
                              <small>{member.email}</small>
                            </div>
                          </div>
                        </td>
                        <td>{member.role}</td>
                        <td>
                          <Badge value={member.status} />
                        </td>
                        <td>
                          {canManage && grantable.some((role) => role.id === member.roleId) && (
                            <button
                              className="icon-button"
                              aria-label={`Edit ${member.name}`}
                              onClick={() => {
                                setRemoving(false);
                                setEditing(member);
                              }}
                            >
                              <Ellipsis size={18} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!members.length && (
                  <Empty title="No team members">
                    Invite a member to give them access to this DSP.
                  </Empty>
                )}
              </div>
            )}
          </DataState>
        </>
      )}
      {tab === 'roles' && <RolesTab view={view} roles={roles.data} edit={setRoleEditor} />}
      {roleEditor && (
        <RoleSheet
          view={view}
          role={roleEditor === 'new' ? undefined : roleEditor}
          close={() => setRoleEditor(undefined)}
          saved={async (permissionsChanged) => {
            if (permissionsChanged) await reopen();
            roles.refresh();
            refresh();
          }}
        />
      )}
      {tab === 'invitations' && canInvite && (
        <>
          <div className="table-toolbar">
            <p className="muted">Pending invitations to your DSP.</p>
            <button
              className="icon-button"
              aria-label="Refresh invitations"
              onClick={invitations.refresh}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email address</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.data
                  ?.filter(
                    (invitation) => !invitation.accepted && invitation.expiresAt > Date.now(),
                  )
                  .map((invitation, index) => (
                    <tr key={`${invitation.email}:${index}`}>
                      <td>{invitation.email}</td>
                      <td>{invitation.role}</td>
                      <td>
                        {time(new Date(invitation.expiresAt).toISOString(), view.dsp.timezone)}
                      </td>
                      <td>
                        <button
                          className="text-button"
                          aria-label={`Revoke invitation for ${invitation.email}`}
                          onClick={() => setRevoking(invitation)}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {(invitations.data?.filter(
              (invitation) => !invitation.accepted && invitation.expiresAt > Date.now(),
            ).length ?? 0) === 0 && (
              <Empty title="No invitations">Invite a team member to get started.</Empty>
            )}
          </div>
        </>
      )}
      {revoking && (
        <ConfirmDialog
          title="Revoke invitation"
          confirm="Revoke invitation"
          onConfirm={() => void revoke.run(revoking)}
          onCancel={() => setRevoking(undefined)}
        >
          Revoke the pending invitation for {revoking.email}? Its link will stop working.
        </ConfirmDialog>
      )}
      {inviting && (
        <Modal
          variant="sheet"
          title="Invite member"
          description={`Give someone access to ${view.dsp.name}.`}
          onClose={() => setInviting(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void invite.run(new FormData(event.currentTarget));
            }}
          >
            <label>
              Email address
              <input name="email" type="email" required />
            </label>
            <label>
              Role
              <select
                name="role"
                required
                defaultValue={
                  (grantable.find((role) => role.name === 'Member') ?? grantable.at(-1))?.id
                }
              >
                {grantable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setInviting(false)}>
                Cancel
              </button>
              <button className="primary">Send invitation</button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal variant="sheet" title={`Edit ${editing.name}`} onClose={() => setEditing(undefined)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void assign.run(editing, new FormData(event.currentTarget).get('role'));
            }}
          >
            <label>
              Role
              <select name="role" defaultValue={editing.roleId ?? undefined}>
                {grantable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            {removing ? (
              <div className="form-actions" role="group" aria-label="Remove member confirmation">
                <span>Remove {editing.name} and delete their account?</span>
                <button type="button" onClick={() => setRemoving(false)}>
                  Keep member
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void assign.run(editing, null)}
                >
                  Remove member
                </button>
              </div>
            ) : (
              <div className="form-actions">
                <button type="button" className="danger" onClick={() => setRemoving(true)}>
                  Remove member
                </button>
                <button className="primary">Save role</button>
              </div>
            )}
          </form>
        </Modal>
      )}
    </>
  );
}
