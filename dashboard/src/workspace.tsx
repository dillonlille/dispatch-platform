import { useState } from 'react';
import { Wrench, Plug, ArrowRight, RefreshCw, Plus, Search, Ellipsis } from 'lucide-react';
import type { Connection, DspView, Membership } from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import { Badge, Empty, ErrorBox, Header, Loading, Modal, Tabs, title, time } from './ui.js';
import { EmployeesPage, TimecardsPage } from './dsp.js';
import { InvitationLink, JobsPage, type Perform } from './platform.js';

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
  const overview = useData<{ connection: Connection; workforce: { collectedAt: string | null } }>(
    '/api/dsp/overview',
    5000,
  );
  const { error, refresh } = overview;
  const data = overview.data?.connection;
  const owner = ['owner', 'platform_owner'].includes(view.role);
  return (
    <div className="paycom-page">
      <Header
        title="Paycom"
        subtitle={
          owner && !data?.enabled
            ? 'Connect Paycom to verify your login.'
            : 'Daily timecards and employee records.'
        }
      />
      {owner && (
        <div className="paycom-settings-button">
          <button
            onClick={() => {
              location.hash = `dsp/${view.dsp.id}/settings?tab=connections`;
            }}
          >
            Paycom settings
          </button>
        </div>
      )}
      {owner && <ErrorBox message={error} />}
      {owner && !data && !error ? (
        <Loading />
      ) : owner && data && !data.enabled ? (
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
              <Badge value={data?.status ?? 'idle'} />
              {overview.data?.workforce.collectedAt && (
                <span className="muted">
                  Last successful sync {time(overview.data.workforce.collectedAt)}
                </span>
              )}
              <button
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
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              ['timecards', 'Timecard'],
              ['employees', 'Employees'],
              ...(canCollect ? [['collections', 'Collections']] : []),
            ]}
            label="Paycom"
          />
          <div className="embedded-page">
            {tab === 'employees' ? (
              <EmployeesPage />
            ) : tab === 'collections' ? (
              <JobsPage platform={false} perform={perform} canCollect={canCollect} />
            ) : (
              <TimecardsPage timezone={view.dsp.timezone} />
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
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Access</th>
                <th>Members</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['owner', 'Manage members, settings, connections and collections'],
                ['manager', 'View workforce and manage collections'],
                ['member', 'View workforce and timecards'],
              ].map(([role, description]) => (
                <tr key={role}>
                  <td>
                    <strong>{title(role!)}</strong>
                  </td>
                  <td>{description}</td>
                  <td>{data?.filter((member) => member.role === role).length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'invitations' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email address</th>
                <th>Role</th>
                <th>Status</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {invitations.data?.map((invitation, index) => (
                <tr key={`${invitation.email}:${index}`}>
                  <td>{invitation.email}</td>
                  <td>{title(invitation.role)}</td>
                  <td>
                    {invitation.accepted
                      ? 'Accepted'
                      : invitation.expiresAt < Date.now()
                        ? 'Expired'
                        : 'Pending'}
                  </td>
                  <td>{time(new Date(invitation.expiresAt).toISOString())}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {invitations.data?.length === 0 && (
            <Empty title="No invitations">Invite a team member to get started.</Empty>
          )}
        </div>
      )}
      {inviting && (
        <Modal variant="sheet" title="Invite member" onClose={() => setInviting(false)}>
          <p className="muted">Give someone access to {view.dsp.name}.</p>
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
