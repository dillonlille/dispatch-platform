import { useState, type FormEvent } from 'react';
import { ArrowRight, RefreshCw, Search, Link2, Users, Clock3, CalendarClock } from 'lucide-react';
import type {
  DspView,
  Connection,
  Schedule,
  Job,
  AuditEvent,
  Employee,
  Timecard,
  Membership,
} from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import { Badge, Empty, ErrorBox, Header, Loading, Modal, Section, time, title } from './ui.js';
import { Activity, InvitationLink, JobTable, type Perform } from './platform.js';
type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
type Daily = {
  rows: (Timecard & { name: string })[];
  collectedAt: string | null;
  available: boolean;
};
export function Overview({
  view,
  perform,
  navigate,
  canCollect,
}: {
  view: DspView;
  perform: Perform;
  navigate: (page: string) => void;
  canCollect: boolean;
}) {
  const { data, error, refresh } = useData<{
    connection: Connection;
    schedule: Schedule;
    jobs: Job[];
    workforce: Employees;
    audit: AuditEvent[];
  }>('/api/dsp/overview', 5000);
  return (
    <>
      <Header title={view.dsp.name} subtitle="A current view of your team and daily operations.">
        {canCollect && (
          <button
            className="primary"
            disabled={!data?.connection.enabled}
            onClick={() =>
              void perform(async () => {
                await api('/api/dsp/jobs', { requestId: crypto.randomUUID() });
                refresh();
              }, 'Collection queued')
            }
          >
            <RefreshCw size={16} />
            Collect data
          </button>
        )}
      </Header>
      <ErrorBox message={error} />
      <div className="badge-row">
        <Badge value={view.dsp.environment} />
        <Badge value={view.dsp.status} />
        <span className="muted">{view.dsp.timezone}</span>
      </div>
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="metric-grid">
            <div>
              <Users size={20} />
              <span>Employees</span>
              <strong>{data.workforce.total}</strong>
              <small>In your latest collection</small>
            </div>
            <div>
              <Link2 size={20} />
              <span>Paycom</span>
              <strong className="metric-label">
                {title(data.connection.status === 'ready' ? 'connected' : data.connection.status)}
              </strong>
              <small>{data.connection.accountLabel ?? 'Connection not configured'}</small>
            </div>
            <div>
              <CalendarClock size={20} />
              <span>Next collection</span>
              <strong className="metric-label">
                {data.schedule.enabled ? data.schedule.localTime : 'Manual'}
              </strong>
              <small>{data.schedule.enabled ? view.dsp.timezone : 'No automatic schedule'}</small>
            </div>
          </div>
          <div className="workspace-callout">
            <div className="entity-icon">
              <Clock3 size={20} />
            </div>
            <div>
              <strong>Latest workforce data</strong>
              <p>
                {data.workforce.collectedAt
                  ? `Collected ${time(data.workforce.collectedAt)}`
                  : 'Connect Paycom and collect data to see your team.'}
              </p>
            </div>
            <button onClick={() => navigate('employees')}>
              View employees <ArrowRight size={15} />
            </button>
          </div>
          <Section
            title="Recent collections"
            action={
              <button className="text-button" onClick={() => navigate('jobs')}>
                View all <ArrowRight size={15} />
              </button>
            }
          >
            <JobTable
              jobs={data.jobs.slice(0, 4)}
              perform={perform}
              refresh={refresh}
              cancel={canCollect}
            />
          </Section>
          <Section title="Workspace activity">
            <Activity events={data.audit.slice(0, 5)} />
          </Section>
        </>
      )}
    </>
  );
}
export function EmployeesPage() {
  const [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [employee, setEmployee] = useState<string>();
  const { data, error } = useData<Employees>(
    `/api/dsp/employees?q=${encodeURIComponent(query)}&offset=${offset}&limit=25`,
  );
  return (
    <>
      <Header title="Employees" subtitle="Your workforce, collected from Paycom." />
      <div className="toolbar">
        <label className="search">
          <Search size={18} />
          <input
            aria-label="Search employees"
            placeholder="Search name or employee code…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <span className="muted">
          {data?.total ?? 0} employees · Collected {time(data?.collectedAt)}
        </span>
      </div>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Code</th>
                  <th>Department</th>
                  <th>Position</th>
                  <th>Station</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.employees.map((person) => (
                  <tr key={person.code}>
                    <td>
                      <button className="employee-link" onClick={() => setEmployee(person.code)}>
                        <span className="avatar pale">
                          {person.name
                            .split(' ')
                            .map((s) => s[0])
                            .slice(0, 2)
                            .join('')}
                        </span>
                        {person.name}
                      </button>
                    </td>
                    <td>{person.code}</td>
                    <td>{person.department || '—'}</td>
                    <td>{person.position || '—'}</td>
                    <td>{person.station || '—'}</td>
                    <td>
                      <Badge value={person.active ? 'active' : 'inactive'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.employees.length && (
              <Empty title={query ? 'No employees match your search' : 'No workforce data yet'}>
                {query
                  ? 'Try another name or employee code.'
                  : 'Run your first collection to bring your team into Dispatch.'}
              </Empty>
            )}
          </div>
          <div className="pagination">
            <span>
              {data.total
                ? `${offset + 1}–${Math.min(offset + 25, data.total)} of ${data.total}`
                : '0 employees'}
            </span>
            <button disabled={!offset} onClick={() => setOffset((v) => Math.max(0, v - 25))}>
              Previous
            </button>
            <button disabled={offset + 25 >= data.total} onClick={() => setOffset((v) => v + 25)}>
              Next
            </button>
          </div>
        </>
      )}
      {employee && <EmployeeDetail code={employee} close={() => setEmployee(undefined)} />}
    </>
  );
}
function EmployeeDetail({ code, close }: { code: string; close: () => void }) {
  const { data, error } = useData<{ employee: Employee; timecards: Timecard[] }>(
    `/api/dsp/employees/${encodeURIComponent(code)}`,
  );
  return (
    <Modal title={data?.employee.name ?? 'Employee'} onClose={close}>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <p className="muted">
            {data.employee.position} · {code} · {data.employee.department}
          </p>
          <h3>Collected timecards</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Hours</th>
                  <th>Punches</th>
                </tr>
              </thead>
              <tbody>
                {data.timecards.map((card) => (
                  <tr key={card.date}>
                    <td>{card.date}</td>
                    <td>{card.hours.toFixed(2)}</td>
                    <td>
                      {card.punches.map((p, i) => (
                        <small key={i}>
                          {p.in ?? '—'} – {p.out ?? '—'}
                        </small>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
function today(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day']
    .map((name) => parts.find((p) => p.type === name)!.value)
    .join('-');
}
export function TimecardsPage({ timezone }: { timezone: string }) {
  const [date, setDate] = useState(() => today(timezone)),
    [sort, setSort] = useState('name'),
    [direction, setDirection] = useState('asc'),
    [selected, setSelected] = useState<Daily['rows'][number]>();
  const { data, error } = useData<Daily>(
    `/api/dsp/timecards?date=${date}&sort=${sort}&direction=${direction}`,
  );
  return (
    <>
      <Header title="Timecards" subtitle={`Daily hours and punches, shown in ${timezone}.`} />
      <div className="toolbar">
        <label className="inline-label">
          Date
          <input
            type="date"
            aria-label="Timecard date"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
          />
        </label>
        <select aria-label="Sort timecards" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="name">Sort by name</option>
          <option value="hours">Sort by hours</option>
        </select>
        <select
          aria-label="Sort direction"
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : !data.available ? (
        <Empty title="No collection covers this date">
          Choose another date or collect the current pay period.
        </Empty>
      ) : (
        <>
          <div className="summary-strip">
            <div>
              <span>Employees</span>
              <strong>{data.rows.length}</strong>
            </div>
            <div>
              <span>Total hours</span>
              <strong>{data.rows.reduce((sum, row) => sum + row.hours, 0).toFixed(2)}</strong>
            </div>
            <div>
              <span>Collected</span>
              <strong className="metric-label">{time(data.collectedAt)}</strong>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Code</th>
                  <th>Hours</th>
                  <th>Status</th>
                  <th>Punches</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((card) => (
                  <tr key={card.employeeCode}>
                    <td>
                      <strong>{card.name}</strong>
                    </td>
                    <td>{card.employeeCode}</td>
                    <td>{card.hours.toFixed(2)}</td>
                    <td>{card.status}</td>
                    <td>
                      <button className="text-button" onClick={() => setSelected(card)}>
                        View punches
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {selected && (
        <Modal title={`${selected.name} · ${selected.date}`} onClose={() => setSelected(undefined)}>
          {selected.punches.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>In</th>
                    <th>Out</th>
                    <th>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.punches.map((p, i) => (
                    <tr key={i}>
                      <td>{p.in ?? '—'}</td>
                      <td>{p.out ?? '—'}</td>
                      <td>{p.hours === null ? '—' : p.hours.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No punches recorded" />
          )}
        </Modal>
      )}
    </>
  );
}
export function ConnectionsPage({
  perform,
  development,
}: {
  perform: Perform;
  development: boolean;
}) {
  const { data, error, refresh } = useData<Connection>('/api/dsp/connections', 4000),
    schedule = useData<Schedule>('/api/dsp/schedule');
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [assistance, setAssistance] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const ok = await perform(async () => {
      await api('/api/dsp/connections/paycom', {
        clientCode: form.get('clientCode'),
        username: form.get('username'),
        password: form.get('password'),
      });
      refresh();
    }, 'Connection saved');
    setBusy(false);
    if (ok) setEditing(false);
  }
  return (
    <>
      <Header
        title="Connections"
        subtitle="Connect your providers and manage collection schedules."
      />
      <ErrorBox message={error} />
      <Section title="Paycom" action={data && <Badge value={data.status} />}>
        <div className="connection-body">
          <div className="provider-logo">P</div>
          <div className="connection-description">
            <h3>Workforce & timecards</h3>
            <p>Collect employees, daily hours, and time punches for this DSP.</p>
            {data?.accountLabel && (
              <small>
                Account {data.accountLabel} · Verified {time(data.lastVerifiedAt)}
              </small>
            )}
            {data?.error && <ErrorBox message={title(data.error)} />}
          </div>
          <div className="row-actions">
            <button className="primary" onClick={() => setEditing(true)}>
              {data?.enabled ? 'Update credentials' : 'Connect Paycom'}
            </button>
            {data?.enabled && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await api('/api/dsp/connections/paycom/check', {});
                    refresh();
                  }, 'Connection checked')
                }
              >
                Check connection
              </button>
            )}
          </div>
        </div>
        {data?.status === 'needs_verification' && (
          <div className="verification">
            <h3>Paycom needs your verification</h3>
            <p>
              Enter the code from your provider, or open browser assistance to complete its prompt.
            </p>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void perform(async () => {
                  await api('/api/dsp/connections/paycom/verify', { code: form.get('code') });
                  refresh();
                }, 'Verification submitted');
              }}
            >
              <input
                name="code"
                aria-label="Verification code"
                autoComplete="one-time-code"
                required
                maxLength={128}
              />
              <button className="primary">Verify</button>
              <button type="button" onClick={() => setAssistance(true)}>
                Browser assistance
              </button>
            </form>
            {development && <small>Synthetic fixture verification code: 123456.</small>}
          </div>
        )}
        {data?.enabled && (
          <div className="panel-footer">
            <button
              className="text-button danger"
              onClick={() =>
                void perform(async () => {
                  await api('/api/dsp/connections/paycom/disable', { removeCredentials: true });
                  refresh();
                  schedule.refresh();
                }, 'Paycom disconnected')
              }
            >
              Disconnect and remove saved credentials
            </button>
            <small>Automatic collections stop when disconnected.</small>
          </div>
        )}
      </Section>
      <Section title="Collection schedule">
        {schedule.data && (
          <form
            className="settings-form"
            key={JSON.stringify(schedule.data)}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                await api('/api/dsp/schedule', {
                  enabled: form.get('enabled') === 'on',
                  localTime: form.get('localTime'),
                });
                schedule.refresh();
              }, 'Schedule saved');
            }}
          >
            <label className="checkbox-label">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={schedule.data.enabled}
                disabled={!data?.enabled}
              />
              Collect automatically each day
            </label>
            <div className="inline-form">
              <label>
                Collection time
                <input
                  name="localTime"
                  type="time"
                  required
                  defaultValue={schedule.data.localTime}
                />
              </label>
              <span className="muted">{schedule.data.timezone}</span>
            </div>
            <p className="muted">
              Next collection:{' '}
              {schedule.data.nextRun ? time(schedule.data.nextRun) : 'Not scheduled'}
            </p>
            <button className="primary" disabled={!data?.enabled}>
              Save schedule
            </button>
          </form>
        )}
        <ErrorBox message={schedule.error} />
      </Section>
      {editing && (
        <Modal
          title={data?.enabled ? 'Update Paycom credentials' : 'Connect Paycom'}
          onClose={() => setEditing(false)}
        >
          <p className="muted">
            Credentials are private to this DSP. Replacing them starts a fresh browser session.
          </p>
          {development && (
            <div className="notice">
              Development uses synthetic data. Use any test credentials; use password
              “require-verification” to exercise verification.
            </div>
          )}
          <form onSubmit={(event) => void save(event)}>
            <label>
              Client code
              <input
                name="clientCode"
                required
                maxLength={80}
                autoComplete="off"
                defaultValue={data?.accountLabel ?? ''}
              />
            </label>
            <label>
              Username
              <input name="username" required maxLength={200} autoComplete="off" />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                maxLength={256}
                autoComplete="new-password"
              />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? 'Connecting…' : 'Save and connect'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {assistance && (
        <BrowserAssistance
          perform={perform}
          close={() => {
            setAssistance(false);
            refresh();
          }}
        />
      )}
    </>
  );
}
function BrowserAssistance({ perform, close }: { perform: Perform; close: () => void }) {
  const { data, error, refresh } = useData<{ image: string }>(
    '/api/dsp/connections/paycom/screenshot',
    3000,
  );
  const [text, setText] = useState('');
  return (
    <Modal title="Private browser assistance" onClose={close}>
      <p>
        Complete the provider prompt in this DSP’s browser. Click the image to select a field, then
        enter text below.
      </p>
      <ErrorBox message={error} />
      {data && (
        <img
          className="browser-image"
          alt="Current provider verification screen"
          src={`data:image/png;base64,${data.image}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            void perform(async () => {
              await api('/api/dsp/connections/paycom/assist', {
                kind: 'click',
                x: ((event.clientX - rect.left) * 1200) / rect.width,
                y: ((event.clientY - rect.top) * 800) / rect.height,
              });
              refresh();
            });
          }}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            await api('/api/dsp/connections/paycom/assist', { kind: 'type', text });
            setText('');
            refresh();
          });
        }}
      >
        <label>
          Text to enter
          <input
            type="password"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={256}
          />
        </label>
        <div className="form-actions">
          <button>Type text</button>
          <button
            type="button"
            onClick={() =>
              void perform(async () => {
                await api('/api/dsp/connections/paycom/assist', { kind: 'key', key: 'Enter' });
                refresh();
              })
            }
          >
            Press Enter
          </button>
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function DspSettings({
  view,
  perform,
  reopen,
  onSuspended,
}: {
  view: DspView;
  perform: Perform;
  reopen: () => Promise<void>;
  onSuspended: () => void;
}) {
  const { data, error, refresh } = useData<Membership[]>('/api/dsp/members');
  const [inviting, setInviting] = useState(false),
    [link, setLink] = useState(''),
    [suspending, setSuspending] = useState(false);
  return (
    <>
      <Header title="DSP settings" subtitle="Manage workspace details and team access." />
      <Section title="Workspace details">
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void perform(async () => {
              await api('/api/dsp/settings', {
                name: form.get('name'),
                timezone: form.get('timezone'),
              });
              await reopen();
            }, 'Workspace saved');
          }}
        >
          <label>
            DSP name
            <input name="name" required defaultValue={view.dsp.name} maxLength={100} />
          </label>
          <label>
            Timezone
            <input name="timezone" required defaultValue={view.dsp.timezone} />
          </label>
          <button className="primary">Save details</button>
        </form>
      </Section>
      <Section
        title="Team access"
        action={<button onClick={() => setInviting(true)}>Invite member</button>}
      >
        <ErrorBox message={error} />
        {!data ? (
          <Loading />
        ) : !data.length ? (
          <Empty title="No DSP members yet">Invite an owner to manage this workspace.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {data.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <strong>{member.name}</strong>
                    </td>
                    <td>{member.email}</td>
                    <td>
                      <select
                        aria-label={`Role for ${member.name}`}
                        value={member.role}
                        onChange={(e) =>
                          void perform(async () => {
                            await api(`/api/dsp/members/${member.id}`, { role: e.target.value });
                            await reopen();
                            refresh();
                          }, 'Role updated')
                        }
                      >
                        <option value="owner">Owner</option>
                        <option value="manager">Manager</option>
                        <option value="member">Member</option>
                      </select>
                    </td>
                    <td>
                      <button
                        className="text-button danger"
                        onClick={() =>
                          void perform(async () => {
                            await api(`/api/dsp/members/${member.id}`, { role: null });
                            await reopen();
                            refresh();
                          }, 'Member removed')
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel-footer">
          <small>
            Owners manage access and connections. Managers collect data. Members view workforce
            data.
          </small>
        </div>
      </Section>
      {view.role === 'platform_owner' && !view.dsp.permanent && (
        <Section title="Workspace availability">
          <div className="settings-form">
            <p>
              Suspending this DSP blocks access and cancels its collections. You can resume it from
              the DSP list.
            </p>
            <button className="danger" onClick={() => setSuspending(true)}>
              Suspend DSP
            </button>
          </div>
        </Section>
      )}
      {inviting && (
        <Modal title="Invite a team member" onClose={() => setInviting(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                const result = await api<{ invitationUrl: string }>('/api/dsp/members/invite', {
                  email: form.get('email'),
                  role: form.get('role'),
                });
                setInviting(false);
                setLink(result.invitationUrl);
              }, 'Invitation created');
            }}
          >
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Role
              <select name="role">
                <option value="member">Member</option>
                <option value="manager">Manager</option>
                <option value="owner">Owner</option>
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
      {link && <InvitationLink link={link} close={() => setLink('')} />}
      {suspending && (
        <Modal title={`Suspend ${view.dsp.name}?`} onClose={() => setSuspending(false)}>
          <p>Members lose access and active collections are cancelled until you resume this DSP.</p>
          <div className="form-actions">
            <button onClick={() => setSuspending(false)}>Cancel</button>
            <button
              className="danger"
              onClick={() =>
                void perform(async () => {
                  await api(`/api/platform/dsps/${view.dsp.id}/status`, { status: 'suspended' });
                  onSuspended();
                }, 'DSP suspended')
              }
            >
              Suspend DSP
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
