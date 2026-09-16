import { useEffect, useState } from 'react';
import { Wrench, Plug, ArrowRight, RefreshCw, Plus, Search, Ellipsis } from 'lucide-react';
import type { Connection, DspView, Membership, Job } from '../../shared/contracts/index.js';
import { paycomDefaults, type PaycomSettings } from '../../shared/paycom.js';
import { api, useData } from './api.js';
import { Badge, Empty, ErrorBox, Header, Loading, Modal, Tabs, title, time } from './ui.js';
import { EmployeesPage, TimecardsPage } from './dsp.js';
import { MealBreaksPage } from './meal-breaks.js';
import { InvitationLink, type Perform } from './platform.js';

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

export function PaycomPage({
  view,
  perform,
  canCollect,
}: {
  view: DspView;
  perform: Perform;
  canCollect: boolean;
}) {
  const [tab, setTab] = useState('timecards');
  const preferences = useData<PaycomSettings>('/api/dsp/paycom/settings');
  useEffect(() => {
    if (preferences.data) setTab(preferences.data.values.opening_page);
  }, [preferences.data]);
  const overview = useData<{
    connection: Connection;
    workforce: { collectedAt: string | null };
    jobs: Job[];
  }>('/api/dsp/overview', 5000);
  const { error, refresh } = overview;
  const data = overview.data?.connection;
  const owner = ['owner', 'platform_owner'].includes(view.role);
  return (
    <div className="paycom-page">
      <Header title="Paycom" subtitle="Timecards, meal breaks, and employee records.">
        {owner && (
          <button
            onClick={() => {
              location.hash = `dsp/${view.dsp.id}/paycom-settings`;
            }}
          >
            Paycom settings
          </button>
        )}
      </Header>
      {owner && <ErrorBox message={error} />}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['timecards', 'Timecard'],
          ['meal-breaks', 'Meal Breaks'],
          ['employees', 'Employees'],
        ]}
        label="Paycom"
      />
      {tab === 'meal-breaks' ? (
        <MealBreaksPage
          timezone={view.dsp.timezone}
          owner={owner}
          preferences={preferences.data?.values ?? paycomDefaults}
        />
      ) : owner && !data && !error ? (
        <Loading />
      ) : owner && data && !data.enabled && !overview.data?.workforce.collectedAt ? (
        <section className="paycom-connection" aria-labelledby="paycom-connection-title">
          <header className="paycom-connection-header">
            <div className="paycom-connection-identity">
              <Plug size={24} />
              <div>
                <h2 id="paycom-connection-title">Workforce connection</h2>
                <p className="muted">Confirm that your Paycom login works.</p>
              </div>
            </div>
            <Badge value={data.status} />
          </header>
          <div className="paycom-connection-body">
            <h3>Connect your Paycom account</h3>
            <p>Paycom is not connected. You can keep using your DSP and connect it later.</p>
            <button
              className="primary"
              onClick={() => {
                location.hash = `dsp/${view.dsp.id}/settings?tab=connections`;
              }}
            >
              Connection settings
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      ) : (
        <>
          {canCollect && (
            <div className="paycom-sync-status">
              <span role="status" aria-label="Paycom sync">
                {overview.data?.jobs[0]?.status === 'succeeded'
                  ? 'Sync complete'
                  : overview.data?.jobs[0]?.status === 'failed'
                    ? 'Last collection failed'
                    : ['queued', 'running', 'waiting_verification'].includes(
                          overview.data?.jobs[0]?.status ?? '',
                        )
                      ? title(overview.data!.jobs[0]!.status)
                      : data?.enabled
                        ? 'Waiting for next sync'
                        : 'Sync paused'}
              </span>
              {overview.data?.workforce.collectedAt && (
                <span className="muted">
                  Last successful sync {time(overview.data.workforce.collectedAt)}
                </span>
              )}
              <button
                disabled={!data?.enabled}
                onClick={() =>
                  void perform(async () => {
                    await api('/api/dsp/jobs', { requestId: crypto.randomUUID() });
                    refresh();
                  }, 'Collection queued')
                }
              >
                <RefreshCw size={16} />
                Sync now
              </button>
            </div>
          )}
          <div className="embedded-page">
            {tab === 'employees' ? (
              <EmployeesPage preferences={preferences.data?.values ?? paycomDefaults} />
            ) : (
              <TimecardsPage
                key={preferences.data?.revision ?? 'loading'}
                timezone={view.dsp.timezone}
                preferences={preferences.data?.values ?? paycomDefaults}
              />
            )}
          </div>
        </>
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
  const [link, setLink] = useState('');
  const [revoking, setRevoking] = useState<Invitation>();
  const members =
    data?.filter((member) =>
      `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Header title="Team & Roles" subtitle="Manage your team and their access.">
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
              void perform(async () => {
                const result = await api<{ invitationUrl: string }>('/api/dsp/members/invite', {
                  email: form.get('email'),
                  role: form.get('role'),
                });
                setLink(result.invitationUrl);
                setInviting(false);
                invitations.refresh();
              }, 'Invitation created');
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
              <button className="primary">Create invitation</button>
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
      {link && <InvitationLink link={link} close={() => setLink('')} />}
    </>
  );
}
