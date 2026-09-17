import { useState } from 'react';
import { Wrench, ArrowRight, RefreshCw, Plus, Search, Ellipsis, Settings } from 'lucide-react';
import type { Connection, DspView, Membership, Job } from '../../shared/contracts/index.js';
import { paycomDefaults, type PaycomSettings } from '../../shared/paycom.js';
import { api, useData } from './api.js';
import { Badge, Empty, ErrorBox, Header, Loading, Modal, Tabs, title, time } from './ui.js';
import { EmployeesPage, TimecardsPage } from './dsp.js';
import { MealBreaksPage } from './meal-breaks.js';
import { PaycomDateControls, usePaycomDate } from './paycom-day-controls.js';
import { calendarTimezone, displayTimezone } from './preferences.js';
import { localDate } from '../../shared/meal-breaks.js';
import { type Perform } from './platform.js';

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
  compact = false,
}: {
  name: string;
  source?: SyncSource;
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
      collectedAt &&
      localDate(calendarTimezone(), new Date(collectedAt)) === localDate(calendarTimezone());
    const timestamp = collectedAt
      ? collectedToday
        ? new Intl.DateTimeFormat('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: displayTimezone(),
          }).format(new Date(collectedAt))
        : time(collectedAt)
      : null;
    return (
      <div className="paycom-header-sync" role="status" aria-label={`${name} sync`}>
        <Badge
          value={
            message === 'Sync complete'
              ? 'succeeded'
              : source?.active
                ? (status ?? 'running')
                : status === 'failed'
                  ? 'failed'
                  : 'pending'
          }
        >
          {name} {message === 'Sync complete' ? 'synced' : message.toLowerCase()}
        </Badge>
        {collectedAt && (
          <span className="paycom-sync-timestamp">
            ·{' '}
            <time dateTime={collectedAt} title={`Last successful sync ${time(collectedAt)}`}>
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
        <span className="muted">Last successful sync {time(source.collectedAt)}</span>
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
  const [selectedTab, setTab] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const { date, today, timezone, selectDate } = usePaycomDate(view.dsp.id);
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
  const sourceState = syncState.data?.date === date ? syncState.data : undefined;
  const { error, refresh } = overview;
  const data = overview.data?.connection;
  const meals = tab === 'meal-breaks';
  const timecards = tab === 'timecards';
  const activeSync = sourceState?.paycom.active || (meals && sourceState?.flex.active);
  const collectedAt = overview.data?.workforce.collectedAt;
  const refreshKey = `${sourceState?.paycom.collectedAt ?? collectedAt}:${sourceState?.flex.collectedAt}`;
  const syncUnavailable = meals
    ? !sourceState
      ? 'Checking connections…'
      : !sourceState.paycom.enabled
        ? 'Connect Paycom in Settings → Connections to sync.'
        : !sourceState.flex.enabled
          ? 'Connect Cortex in Settings → Connections to sync Flex.'
          : !sourceState.scopeAvailable
            ? 'Flex needs an initial station collection before Sync now is available.'
            : ''
    : !data?.enabled
      ? 'Connect Paycom to sync.'
      : '';
  const owner = ['owner', 'platform_owner'].includes(view.role);
  const syncButton = canCollect && (
    <button
      disabled={!!syncUnavailable || !!syncState.error || syncing || !!activeSync}
      title={
        syncUnavailable ||
        (meals
          ? `Sync Flex and Paycom for ${date}`
          : tab === 'employees'
            ? 'Sync Paycom’s current pay period'
            : `Sync Paycom for ${date}`)
      }
      onClick={async () => {
        setSyncing(true);
        try {
          await perform(
            async () => {
              await api(meals ? '/api/dsp/jobs/meal-breaks' : '/api/dsp/jobs', {
                requestId: crypto.randomUUID(),
                ...(tab !== 'employees' ? { date } : {}),
              });
              refresh();
              syncState.refresh();
            },
            meals ? 'Flex and Paycom collections queued' : 'Paycom collection queued',
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
    <div className={`paycom-page${timecards ? ' paycom-timecards-page' : ''}`}>
      <Header title="Timecard">
        {timecards && canCollect && (
          <SourceSyncStatus name="Paycom" source={sourceState?.paycom} compact />
        )}
        {timecards && syncButton}
        {owner && (
          <button
            onClick={() => {
              location.hash = `dsp/${view.dsp.id}/paycom-settings`;
            }}
          >
            {timecards && <Settings size={16} />}
            Paycom settings
          </button>
        )}
      </Header>
      {owner && <ErrorBox message={error} />}
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
      {!timecards && (
        <section className="paycom-workspace-controls" aria-label="Date and sync">
          <div className="paycom-controls-row">
            {tab !== 'employees' && (
              <PaycomDateControls date={date} today={today} onChange={selectDate} />
            )}
            {syncButton}
          </div>
          {tab !== 'employees' && (
            <p className="paycom-calendar-note muted">
              Calendar timezone: {timezone.replaceAll('_', ' ')}
            </p>
          )}
          {canCollect && (
            <div className="paycom-sync-status">
              <SourceSyncStatus name="Paycom" source={sourceState?.paycom} />
              {meals && <SourceSyncStatus name="Flex" source={sourceState?.flex} />}
              {syncUnavailable && <span className="muted">{syncUnavailable}</span>}
            </div>
          )}
        </section>
      )}
      {timecards && canCollect && syncUnavailable && (
        <p className="paycom-sync-unavailable muted">{syncUnavailable}</p>
      )}
      {tab === 'meal-breaks' ? (
        <MealBreaksPage
          key={date}
          date={date}
          refreshKey={refreshKey}
          timezone={view.dsp.timezone}
          owner={owner}
          preferences={preferences.data?.values ?? paycomDefaults}
        />
      ) : owner && !data && !error ? (
        <Loading />
      ) : owner && data && !data.enabled && !overview.data?.workforce.collectedAt ? (
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
  const invitations = useData<Invitation[]>('/api/dsp/invitations', 10000);
  const [tab, setTab] = useState('members');
  const [search, setSearch] = useState('');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Membership>();
  const [revoking, setRevoking] = useState<Invitation>();
  const members =
    data?.filter((member) =>
      `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Header title="Team & Roles">
        <button className="primary" onClick={() => setInviting(true)}>
          <Plus size={16} />
          Invite member
        </button>
      </Header>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['members', 'Members'],
          ['roles', 'Roles'],
          ['invitations', 'Invitations'],
        ]}
        label="Team"
      />
      <ErrorBox message={error || invitations.error} />
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
                    <th>Access</th>
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
                      <td>{title(member.role)}</td>
                      <td>
                        <Badge value="active">Active</Badge>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`Edit ${member.name}`}
                          onClick={() => setEditing(member)}
                        >
                          <Ellipsis size={18} />
                        </button>
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
      {tab === 'roles' && (
        <>
          <div className="table-toolbar">
            <p className="muted">Standard roles for your DSP.</p>
          </div>
          <div className="role-list">
            {[
              ['owner', 'Manage members, settings, connections and collections'],
              ['manager', 'View workforce and manage collections'],
              ['member', 'View workforce and timecards'],
            ].map(([role, description]) => (
              <section className="role-row" key={role}>
                <div>
                  <div className="role-heading">
                    <h2>{title(role!)}</h2>
                    <span className="muted">Standard role</span>
                  </div>
                  <p>{description}</p>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
      {tab === 'invitations' && (
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
                      <td>{title(invitation.role)}</td>
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
              <select name="role" defaultValue="member">
                <option value="owner">Owner</option>
                <option value="manager">Manager</option>
                <option value="member">Member</option>
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
              <select name="role" defaultValue={editing.role}>
                <option value="owner">Owner</option>
                <option value="manager">Manager</option>
                <option value="member">Member</option>
              </select>
            </label>
            <div className="form-actions">
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
              <button className="primary">Save role</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
