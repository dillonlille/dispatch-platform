import { useUpdateState } from './app/browser-update.js';
import { useCollectionUpdates } from './app/live-collection.js';
import { BrowserVerification } from './features/connections/BrowserVerification.js';
import { PaycomDateControls } from './features/timecard/DateControls.js';
import { localDate } from '../../shared/meal-breaks.js';
import { useState, type FormEvent } from 'react';
import { ArrowLeft, Plug, RefreshCw, ShieldCheck, Globe, Info } from 'lucide-react';
import type { Connection, Employee, Timecard } from '../../shared/contracts/index.js';
import { paycomColumns, type PaycomPreferences, type PaycomColumn } from '../../shared/paycom.js';
import { api, useData } from './app/api.js';
import {
  Badge,
  ConfirmDialog,
  DataState,
  DetailList,
  Empty,
  ErrorBox,
  Modal,
  Pagination,
  SortHeader,
  usePagination,
} from './ui/index.js';
import { time, title } from './lib/format.js';
import { messageOf } from './lib/errors.js';
import { useAction } from './app/useAction.js';
type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
type Daily = {
  rows: (Timecard & { name: string })[];
  collectedAt: string | null;
  available: boolean;
};
const pageSize = 100;
export function EmployeesPage() {
  const [direction, setDirection] = useUpdateState('employee-direction', 'asc');
  const [query, setQuery] = useUpdateState('employee-query', ''),
    [page, setPage] = useUpdateState('employee-page', 0),
    [employee, setEmployee] = useState<string>();
  const { data, error } = useData<Employees>(
    `/api/dsp/employees?q=${encodeURIComponent(query)}&offset=${page * pageSize}&limit=${pageSize}&direction=${direction}`,
  );
  if (employee) return <EmployeeDetail code={employee} close={() => setEmployee(undefined)} />;
  return (
    <div className="paycom-data-view">
      <div className="paycom-employee-search">
        <label>
          Find employee
          <input
            type="search"
            aria-label="Search employees"
            placeholder="Search by name"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
      </div>
      <DataState data={data} error={error}>
        {(data) => (
          <div className="paycom-data-table">
            <div className="paycom-table-heading">
              <h2>Employees</h2>
              <span>{data.total} employees</span>
            </div>
            <div className="table-wrap">
              <table aria-label="Employee directory">
                <thead>
                  <tr>
                    <SortHeader
                      direction={direction === 'asc' ? 'asc' : 'desc'}
                      onSort={() => {
                        setDirection(direction === 'asc' ? 'desc' : 'asc');
                        setPage(0);
                      }}
                    >
                      Employee
                    </SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {data.employees.map((person) => (
                    <tr key={person.code}>
                      <td>
                        <button className="employee-link" onClick={() => setEmployee(person.code)}>
                          {person.name}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.employees.length && (
              <Empty title={query ? 'No employees match your search' : 'No workforce data yet'}>
                {query
                  ? 'Try another name.'
                  : 'Employees will appear after the first collection finishes.'}
              </Empty>
            )}
            <Pagination page={page} pageSize={pageSize} total={data.total} onChange={setPage} />
          </div>
        )}
      </DataState>
    </div>
  );
}
function EmployeeDetail({ code, close }: { code: string; close: () => void }) {
  const { data, error } = useData<{ employee: Employee; timecards: Timecard[] }>(
    `/api/dsp/employees/${encodeURIComponent(code)}`,
  );
  return (
    <div className="paycom-data-view">
      <button className="text-button" onClick={close}>
        <ArrowLeft size={16} />
        Back to employees
      </button>
      <DataState data={data} error={error}>
        {(data) => (
          <>
            <div className="paycom-day-toolbar">
              <div>
                <h2>{data.employee.name}</h2>
                <p className="paycom-source-note">{data.employee.position}</p>
              </div>
              <Badge value={data.employee.active ? 'active' : 'inactive'} />
            </div>
            <DetailList
              className="paycom-employee-details"
              items={[
                ['Employee code', code || '—'],
                ['Department', data.employee.department || '—'],
                ['Delivery station', data.employee.station || '—'],
              ]}
            />
            <h2>Employee timecard</h2>
            <div className="paycom-data-table">
              <div className="table-wrap">
                <table className="paycom-day-table" aria-label="Employee period timecard">
                  <thead>
                    <tr>
                      {[
                        'Date',
                        'Clock in',
                        'Lunch out',
                        'Lunch in',
                        'Clock out',
                        'Hours',
                        'Punch status',
                      ].map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.timecards.map((card) => (
                      <tr key={card.date}>
                        <td>{card.date}</td>
                        <PunchCells card={card} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="paycom-source-note">
              Blank days indicate no recorded activity, not an absence.
            </p>
          </>
        )}
      </DataState>
    </div>
  );
}
function PunchCells({ card }: { card: Timecard }) {
  const values: Record<PaycomColumn, string> = {
    inDay: card.punches[0]?.in ?? '—',
    outLunch:
      card.punches.length > 1
        ? card.punches
            .slice(0, -1)
            .map((p) => p.out ?? '—')
            .join(', ')
        : '—',
    inLunch:
      card.punches.length > 1
        ? card.punches
            .slice(1)
            .map((p) => p.in ?? '—')
            .join(', ')
        : '—',
    outDay: card.punches.at(-1)?.out ?? '—',
    totalHours: card.hours.toFixed(2),
    condition: card.status,
  };
  return (
    <>
      {paycomColumns.map(([key]) => (
        <td key={key}>
          {key === 'condition' ? (
            <Badge value={card.status.toLowerCase() === 'complete' ? 'ready' : 'pending'}>
              {card.status}
            </Badge>
          ) : (
            values[key]
          )}
        </td>
      ))}
    </>
  );
}
export function TimecardsPage({
  date,
  onDateChange,
  refreshKey,
  timezone,
  preferences,
}: {
  date: string;
  onDateChange: (date: string) => void;
  refreshKey?: string | null;
  timezone: string;
  preferences: PaycomPreferences;
}) {
  const [requestedPage, setPage] = useUpdateState('timecard-page', 0);
  const calendarToday = localDate(timezone);
  const [sort, setSort] = useUpdateState('timecard-sort', 'name'),
    [direction, setDirection] = useUpdateState('timecard-direction', 'asc'),
    [selectedCode, setSelectedCode] = useState<string>();
  const liveRevision = useCollectionUpdates(date);
  const {
    data: current,
    stale,
    error,
  } = useData<Daily>(
    `/api/dsp/timecards?date=${date}&sort=${sort}&direction=${direction}`,
    0,
    `${refreshKey}:${liveRevision}`,
    date,
  );
  // The previous day's rows hold the layout, dimmed and inert, until the new day arrives.
  const data = current ?? stale;
  const selected = data?.rows.find((row) => row.employeeCode === selectedCode);
  const { page, start, end } = usePagination(requestedPage, data?.rows.length ?? 0, pageSize);
  function order(key: string) {
    setDirection(sort === key && direction === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setPage(0);
  }
  const sorted = (key: string) =>
    sort === key ? (direction === 'asc' ? 'asc' : 'desc') : undefined;
  return (
    <div className="paycom-data-view">
      <div className="paycom-data-table paycom-timecard-table">
        <div className="paycom-table-heading paycom-timecard-heading">
          <div className="paycom-timecard-title">
            <h2>Employee timecards</h2>
            {data?.available && (
              <span className="paycom-employee-count">{data.rows.length} employees</span>
            )}
          </div>
          <PaycomDateControls
            date={date}
            today={calendarToday}
            onChange={(value) => {
              onDateChange(value);
              setPage(0);
              setSelectedCode(undefined);
            }}
          />
        </div>
        <DataState data={data} error={error} failed={Boolean(error)}>
          {(data) =>
            !data.available ? (
              <Empty title="No collection covers this date">
                Choose another date or collect the current pay period.
              </Empty>
            ) : (
              <div className="paycom-day-results" aria-busy={!current} inert={!current}>
                <div className="table-wrap">
                  <table className="paycom-day-table" aria-label="Daily employee timecards">
                    <thead>
                      <tr>
                        <SortHeader direction={sorted('name')} onSort={() => order('name')}>
                          Employee
                        </SortHeader>
                        {paycomColumns.map(([key, label]) => (
                          <SortHeader key={key} direction={sorted(key)} onSort={() => order(key)}>
                            {label}
                          </SortHeader>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.slice(start, end).map((card) => (
                        <tr key={card.employeeCode}>
                          <td>
                            <button
                              className="employee-timecard"
                              aria-label={`View punches for ${card.name}`}
                              onClick={() => setSelectedCode(card.employeeCode)}
                            >
                              {card.name}
                            </button>
                          </td>
                          <PunchCells card={card} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={data.rows.length}
                  onChange={setPage}
                />
                {!data.rows.length && (
                  <Empty
                    title={
                      preferences.driver_departments?.length === 0
                        ? 'No driver departments selected'
                        : 'No employees match your Timecard settings'
                    }
                  >
                    Your DSP owner can choose which departments appear in Timecard Settings.
                  </Empty>
                )}
              </div>
            )
          }
        </DataState>
        <footer className="paycom-timecard-footer" aria-label="Timecard timezones">
          <span>
            <Globe size={16} aria-hidden="true" />
            {timezone.replaceAll('_', ' ')}
          </span>
          <div className="paycom-timecard-business-time">
            <details className="paycom-timecard-info">
              <summary aria-label="About timecard data">
                <Info size={16} aria-hidden="true" />
              </summary>
              <p>
                Last completed collection {time(data?.collectedAt, timezone)}. Times update during
                collection, and hours may change after corrections.
              </p>
            </details>
          </div>
        </footer>
      </div>
      {selected && (
        <Modal
          title={`${selected.name} · ${selected.date}`}
          onClose={() => setSelectedCode(undefined)}
        >
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
                    <td>{p.hours?.toFixed(2) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
export function ConnectionsPage({
  development,
  timezone,
}: {
  development: boolean;
  timezone: string;
}) {
  return (
    <section className="connections-view" aria-labelledby="connections-heading">
      <div>
        <h2 id="connections-heading">Connections</h2>
      </div>
      <div className="connection-cards">
        <ConnectionCard provider="paycom" development={development} timezone={timezone} />
        <ConnectionCard provider="cortex" development={development} timezone={timezone} />
      </div>
      <p className="connection-permissions muted">
        <ShieldCheck size={16} />
        DSP owners and platform owners can manage these credentials.
      </p>
    </section>
  );
}
function ConnectionCard({
  development,
  provider,
  timezone,
}: {
  development: boolean;
  provider: Connection['provider'];
  timezone: string;
}) {
  const name = provider === 'paycom' ? 'Paycom' : 'Cortex';
  const endpoint = `/api/dsp/connections/${provider}`;
  const { data, error, refresh } = useData<Connection>(
    provider === 'paycom' ? '/api/dsp/connections' : endpoint,
    4000,
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const [credentialError, setCredentialError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState(false),
    [closedVerification, setClosedVerification] = useState<string>();
  const connect = useAction(
    async (credentials: Record<string, unknown>) => {
      try {
        await api(endpoint, credentials);
      } catch (error) {
        setSaveError(messageOf(error));
        throw error;
      } finally {
        refresh();
      }
    },
    { success: 'Connection saved' },
  );
  const verify = useAction(
    async (code: FormDataEntryValue | null) => {
      await api(`${endpoint}/verify`, { code });
      refresh();
    },
    { success: 'Verification submitted' },
  );
  const check = useAction(
    async () => {
      await api(`${endpoint}/check`, {});
      refresh();
    },
    { success: 'Connection checked' },
  );
  const disconnect = useAction(
    async () => {
      await api(`${endpoint}/disable`, { removeCredentials: true });
      refresh();
      setDisconnecting(false);
    },
    { success: () => `${name} disconnected` },
  );
  const saving = connect.busy,
    busy = connect.busy || disconnect.busy;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const securityAnswers = [1, 2, 3, 4, 5].map((number) => String(form.get(`pin${number}`) ?? ''));
    if (provider === 'paycom' && new Set(securityAnswers).size !== 5) {
      setCredentialError('Enter five distinct security PINs in their original Paycom numbering.');
      return;
    }
    setCredentialError('');
    setSaveError('');
    event.currentTarget.reset();
    setEditing(false);
    setClosedVerification(data?.verificationSessionId);
    await connect.run({
      ...(provider === 'paycom' ? { clientCode: form.get('clientCode'), securityAnswers } : {}),
      username: form.get('username'),
      password: form.get('password'),
    });
  }
  return (
    <>
      <DataState data={data} error={error}>
        {(data) => (
          <article className="archived-connection-card">
            <header>
              <h3>
                <Plug size={20} />
                {name}
              </h3>
            </header>
            <div className="archived-connection-content">
              <div role="status">
                <Badge value={saving ? 'signing_in' : data.status} />
              </div>
              <p className="muted">
                {saving
                  ? `Signing in to ${name}…`
                  : data.status === 'ready'
                    ? `Your ${name} connection is ready to use.`
                    : data.enabled
                      ? 'Test your connection or update the saved credentials.'
                      : `Connect your ${name} account to get started.`}
              </p>
              {!saving && <ErrorBox message={saveError || (data.error ? title(data.error) : '')} />}
              {!saving && data.status === 'needs_verification' && (
                <div className="verification">
                  <h3>
                    {provider === 'cortex'
                      ? 'Finish signing in to Cortex'
                      : 'Paycom needs your verification'}
                  </h3>
                  <p>
                    {data.verificationSessionId
                      ? 'Complete the verification in the browser window, then press Submit to continue.'
                      : 'Enter the verification code from your provider.'}
                  </p>
                  {data.verificationSessionId ? (
                    <button type="button" onClick={() => setClosedVerification(undefined)}>
                      Open verification window
                    </button>
                  ) : (
                    <form
                      className="inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void verify.run(new FormData(event.currentTarget).get('code'));
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
                    </form>
                  )}
                  {development && !data.verificationSessionId && (
                    <small>Synthetic fixture verification code: 123456.</small>
                  )}
                </div>
              )}

              {data.lastVerifiedAt && (
                <p className="muted">Last checked: {time(data.lastVerifiedAt, timezone)}</p>
              )}
            </div>
            <footer>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  setCredentialError('');
                  setEditing(true);
                }}
              >
                {data.enabled ? 'Update credentials' : `Connect ${name}`}
              </button>
              {data.enabled && (
                <>
                  <button
                    disabled={
                      busy || data.status === 'signing_in' || data.status === 'needs_verification'
                    }
                    onClick={() => {
                      setSaveError('');
                      void check.run();
                    }}
                  >
                    <RefreshCw size={16} />
                    Test connection
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setDisconnecting(true)}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </footer>
          </article>
        )}
      </DataState>
      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${name}?`}
          confirm="Disconnect"
          busy={busy}
          onConfirm={() => {
            setSaveError('');
            void disconnect.run();
          }}
          onCancel={() => setDisconnecting(false)}
        >
          Features will lose access to this service until you reconnect. Previously collected data
          will remain available.
        </ConfirmDialog>
      )}
      {editing && (
        <Modal title={`${name} credentials`} onClose={() => setEditing(false)}>
          <p className="muted">
            Enter the account your DSP uses. Saved credentials are encrypted and are never displayed
            here.
          </p>
          {development && (
            <div className="notice">
              Development uses synthetic data. Use any test credentials; use password
              “require-verification” to exercise verification.
            </div>
          )}
          <form onSubmit={(event) => void save(event)} onInput={() => setCredentialError('')}>
            {provider === 'paycom' && (
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
            )}
            <label>
              {provider === 'cortex' ? 'Email address' : 'Username'}
              <input
                name="username"
                type={provider === 'cortex' ? 'email' : 'text'}
                required
                maxLength={200}
                autoComplete="off"
              />
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
            {provider === 'paycom' &&
              [1, 2, 3, 4, 5].map((number) => (
                <label key={number}>
                  PIN {number}
                  <input
                    name={`pin${number}`}
                    type="password"
                    required
                    maxLength={64}
                    autoComplete="off"
                  />
                </label>
              ))}
            {provider === 'paycom' && (
              <p className="muted">
                Enter all five distinct security answers in the order configured for your Paycom
                account.
              </p>
            )}
            <ErrorBox message={credentialError} />
            <div className="form-actions">
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save credentials'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {data?.verificationSessionId &&
        closedVerification !== data.verificationSessionId &&
        !editing &&
        !saving &&
        !disconnecting && (
          <BrowserVerification
            key={data.verificationSessionId}
            sessionId={data.verificationSessionId}
            provider={provider}
            close={() => {
              setClosedVerification(data.verificationSessionId);
              refresh();
            }}
          />
        )}
    </>
  );
}
