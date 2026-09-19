import { useUpdateState } from './browser-update.js';
import { useState } from 'react';
import {
  Wrench,
  ArrowRight,
  RefreshCw,
  Plus,
  Search,
  Ellipsis,
  Settings,
  AlertTriangle,
} from 'lucide-react';
import type { Connection, DspView, Membership, Job, Role } from '../../shared/contracts/index.js';
import { paycomDefaults, type PaycomSettings } from '../../shared/paycom.js';
import { api, useData } from './api.js';
import { Badge, Empty, ErrorBox, Header, Loading, Modal, Tabs, title, time, can } from './ui.js';
import { EmployeesPage, TimecardsPage } from './dsp.js';
import { MealBreaksPage } from './meal-breaks.js';
import { usePaycomDate } from './paycom-day-controls.js';
import { localDate } from '../../shared/meal-breaks.js';
import { type Perform } from './platform.js';
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
        ? new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: timezone,
          }).format(new Date(collectedAt))
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

export function PaycomPage({
  view,
  perform,
  canCollect,
}: {
  view: DspView;
  perform: Perform;
  canCollect: boolean;
}) {
  const [selectedTab, setTab] = useUpdateState<string | undefined>('paycom-tab', undefined);
  const [syncing, setSyncing] = useState(false);
  const { date, today, selectDate } = usePaycomDate(view.dsp.id, view.dsp.timezone);
  const preferences = useData<PaycomSettings>('/api/dsp/paycom/settings');
  const tab = selectedTab ?? preferences.data?.values.opening_page ?? 'timecards';
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
  const syncButton = canCollect && (
    <button
      disabled={
        !!syncUnavailable ||
        !!syncState.error ||
        syncing ||
        !!activeSync ||
        (daily && !sourceCurrent)
      }
      title={
        syncUnavailable ||
        (daily ? `Sync Flex and Paycom for ${date}` : 'Sync Paycom’s current pay period')
      }
      onClick={async () => {
        setSyncing(true);
        try {
          await perform(
            async () => {
              await api(daily ? '/api/dsp/jobs/meal-breaks' : '/api/dsp/jobs', {
                requestId: crypto.randomUUID(),
                ...(tab !== 'employees' ? { date } : {}),
              });
              refresh();
              syncState.refresh();
            },
            daily ? 'Flex and Paycom collections queued' : 'Paycom collection queued',
          );
        } finally {
          setSyncing(false);
        }
      }}
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
          <button
            onClick={() => {
              location.hash = `dsp/${view.dsp.id}/paycom-settings`;
            }}
          >
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
          onClick={() => {
            location.hash = `dsp/${view.dsp.id}/settings?tab=connections`;
          }}
        >
          Connect Paycom
          <ArrowRight size={16} />
        </button>
      ) : (
        <div className="embedded-page">
          {tab === 'employees' ? (
            <EmployeesPage preferences={preferences.data?.values ?? paycomDefaults} />
          ) : (
            <TimecardsPage
              key={preferences.data?.revision ?? 'loading'}
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
export function TeamPage({
  view,
  perform,
  reopen,
}: {
  view: DspView;
  perform: Perform;
  reopen: () => Promise<void>;
}) {
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
            <label className="search">
              <Search />
              <input
                aria-label="Search members"
                placeholder="Search members"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <button className="icon-button" aria-label="Refresh members" onClick={refresh}>
              <RefreshCw size={16} />
            </button>
          </div>
          {!data ? (
            <Loading />
          ) : (
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
        </>
      )}
      {tab === 'roles' && <RolesTab view={view} roles={roles.data} edit={setRoleEditor} />}
      {roleEditor && (
        <RoleSheet
          view={view}
          role={roleEditor === 'new' ? undefined : roleEditor}
          perform={perform}
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
                      <td>{time(new Date(invitation.expiresAt).toISOString())}</td>
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
        <Modal title="Revoke invitation" onClose={() => setRevoking(undefined)}>
          <p>Revoke the pending invitation for {revoking.email}? Its link will stop working.</p>
          <div className="form-actions">
            <button onClick={() => setRevoking(undefined)}>Cancel</button>
            <button
              className="primary"
              onClick={() =>
                void perform(async () => {
                  await api('/api/dsp/invitations/revoke', { email: revoking.email });
                  setRevoking(undefined);
                  invitations.refresh();
                }, 'Invitation revoked')
              }
            >
              Revoke invitation
            </button>
          </div>
        </Modal>
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
              const form = new FormData(event.currentTarget);
              void perform(
                async () => {
                  await api('/api/dsp/members/invite', {
                    email: form.get('email'),
                    role: form.get('role'),
                  });
                  setInviting(false);
                  invitations.refresh();
                  roles.refresh();
                },
                `Invitation email queued for ${form.get('email')}`,
              );
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
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                await api(`/api/dsp/members/${editing.id}`, { role: form.get('role') });
                setEditing(undefined);
                await reopen();
                refresh();
              }, 'Role updated');
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
                  onClick={() =>
                    void perform(async () => {
                      await api(`/api/dsp/members/${editing.id}`, { role: null });
                      setEditing(undefined);
                      await reopen();
                      refresh();
                    }, 'Member removed')
                  }
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
