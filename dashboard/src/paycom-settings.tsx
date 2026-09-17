import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { api, useData } from './api.js';
import { Header, Tabs, ErrorBox, Loading, Modal, time } from './ui.js';
import {
  paycomDefaults,
  paycomColumns,
  type PaycomPreferences,
  type PaycomSettings as Snapshot,
} from '../../shared/paycom.js';
import type { Schedule } from '../../shared/contracts/index.js';
import type { Perform } from './platform.js';
const sections = [
  ['sync', 'Sync schedule'],
  ['view', 'Workspace view'],
  ['drivers', 'Driver departments'],
];
export function PaycomSettingsPage({ dspId, perform }: { dspId: string; perform: Perform }) {
  const query = useData<Snapshot>('/api/dsp/paycom/settings', 5000);
  const overview = useData<{ schedule: Schedule; workforce: { collectedAt: string | null } }>(
    '/api/dsp/paycom/status',
    5000,
  );
  const [base, setBase] = useState<Snapshot>();
  const [draft, setDraft] = useState<PaycomPreferences>();
  const [tab, setTab] = useState('sync'),
    [busy, setBusy] = useState(false),
    [reset, setReset] = useState(false),
    [history, setHistory] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!base && query.data) {
      setBase(query.data);
      setDraft(structuredClone(query.data.values));
    }
  }, [query.data, base]);
  if (!base || !draft)
    return (
      <>
        <ErrorBox message={query.error} />
        <Loading />
      </>
    );
  const dirty = JSON.stringify(base.values) !== JSON.stringify(draft);
  const newer = query.data && query.data.revision !== base.revision;
  const edit = <K extends keyof PaycomPreferences>(key: K, value: PaycomPreferences[K]) =>
    setDraft({ ...draft, [key]: value });
  function restoreSection() {
    const keys: (keyof PaycomPreferences)[] =
      tab === 'sync'
        ? ['automatic_sync', 'sync_interval_seconds']
        : tab === 'drivers'
          ? ['driver_departments']
          : [
              'opening_page',
              'rows_per_page',
              'name_order',
              'default_sort',
              'department',
              'station',
              'columns',
            ];
    setDraft((current) => ({
      ...current!,
      ...Object.fromEntries(keys.map((key) => [key, structuredClone(paycomDefaults[key])])),
    }));
  }
  function select(
    key: keyof PaycomPreferences,
    label: string,
    options: (readonly [string | number, string])[],
    description?: string,
  ) {
    return (
      <div>
        <label htmlFor={`paycom-${key}`}>{label}</label>
        <select
          id={`paycom-${key}`}
          value={String(draft![key] ?? '')}
          disabled={busy || (key === 'sync_interval_seconds' && !draft!.automatic_sync)}
          onChange={(event) => {
            const raw = event.target.value;
            edit(
              key,
              (['rows_per_page', 'sync_interval_seconds'].includes(key)
                ? Number(raw)
                : raw || null) as never,
            );
          }}
        >
          {options.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
        {description && <small className="muted">{description}</small>}
      </div>
    );
  }
  return (
    <div className="plugin-settings-page">
      <a className="plugin-settings-back" href={`#dsp/${dspId}/paycom`}>
        ← Back
      </a>
      <Header title="Timecard Settings" />
      <ErrorBox message={query.error || overview.error} />
      {newer && (
        <div className="notice">
          These settings changed in another session. Discard your draft to load the latest settings
          before saving.
        </div>
      )}
      {draft.department &&
        draft.driver_departments !== null &&
        !draft.driver_departments.includes(draft.department) && (
          <p role="status" className="plugin-settings-rule">
            Your default department is excluded from Timecards. Choose an included department or
            update Driver departments.
          </p>
        )}
      <Tabs value={tab} onChange={setTab} items={sections} label="Timecard Settings sections" />
      <div className="plugin-settings-fields">
        {tab === 'sync' && (
          <>
            <div className="plugin-setting-wide">
              <div className="plugin-setting-toggle">
                <div>
                  <label htmlFor="automatic-sync">Automatic sync</label>
                  <p>
                    Keep employees and timecards up to date. Pausing lets the current collection
                    finish.
                  </p>
                </div>
                <input
                  id="automatic-sync"
                  type="checkbox"
                  role="switch"
                  checked={draft.automatic_sync}
                  disabled={busy}
                  onChange={(event) => edit('automatic_sync', event.target.checked)}
                />
              </div>
            </div>
            {select(
              'sync_interval_seconds',
              'Sync every',
              [
                [1800, '30 minutes'],
                [3600, '1 hour'],
                [7200, '2 hours'],
                [14400, '4 hours'],
              ],
              draft.automatic_sync
                ? undefined
                : 'Turn on Automatic sync to change its interval. Your saved interval is remembered.',
            )}
          </>
        )}
        {tab === 'view' && (
          <>
            {select('opening_page', 'Opening page', [
              ['timecards', 'Timecards'],
              ['meal-breaks', 'Meal Breaks'],
              ['employees', 'Employees'],
            ])}
            {select('rows_per_page', 'Rows per page', [
              [25, '25'],
              [50, '50'],
              [100, '100'],
            ])}
            {select(
              'name_order',
              'Name order',
              [
                ['first_last', 'First Last'],
                ['last_first', 'Last, First'],
              ],
              'Choose how employee names appear and sort in Paycom.',
            )}
            {select('default_sort', 'Default sort', [
              ['employeeName', 'Employee name, A–Z'],
              ['condition', 'Punch status'],
              ['inDay', 'Clock-in time, earliest first'],
            ])}
            {select('department', 'Default department', [
              ['', 'All departments'],
              ...base.options.departments.map((d) => [d.value, d.value] as const),
            ])}
            {select('station', 'Default delivery station', [
              ['', 'All stations'],
              ...base.options.stations.map((value) => [value, value] as const),
            ])}
            <fieldset className="plugin-setting-multiple plugin-setting-wide" disabled={busy}>
              <legend>Timecard columns</legend>
              <p>
                Employee names always appear. Select other columns and use the arrows to order them.
              </p>
              <div className="plugin-setting-choices">
                {[
                  ...draft.columns,
                  ...paycomColumns
                    .map(([key]) => key)
                    .filter((key) => !draft.columns.includes(key)),
                ].map((key) => {
                  const index = draft.columns.indexOf(key);
                  const label = paycomColumns.find(([value]) => value === key)![1];
                  return (
                    <div className="plugin-setting-option" key={key}>
                      <label className="plugin-setting-choice">
                        <input
                          type="checkbox"
                          checked={index >= 0}
                          onChange={(event) =>
                            edit(
                              'columns',
                              event.target.checked
                                ? [...draft.columns, key]
                                : draft.columns.filter((value) => value !== key),
                            )
                          }
                        />
                        <span>{label}</span>
                      </label>
                      {index >= 0 && (
                        <div className="row-actions">
                          {[-1, 1].map((offset) => (
                            <button
                              key={offset}
                              className="icon-button"
                              aria-label={`Move ${label} ${offset < 0 ? 'up' : 'down'}`}
                              disabled={
                                index + offset < 0 || index + offset >= draft.columns.length
                              }
                              onClick={() => {
                                const values = [...draft.columns];
                                [values[index], values[index + offset]] = [
                                  values[index + offset]!,
                                  values[index]!,
                                ];
                                edit('columns', values);
                              }}
                            >
                              {offset < 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          </>
        )}
        {tab === 'drivers' && (
          <fieldset className="plugin-setting-multiple plugin-setting-wide" disabled={busy}>
            <legend>Departments shown on Timecards</legend>
            <p>
              Only employees from the selected departments appear on your DSP’s Timecard page.
              Selecting none shows no employees.
            </p>
            <label className="plugin-setting-choice">
              <input
                type="checkbox"
                checked={draft.driver_departments === null}
                onChange={(event) =>
                  edit(
                    'driver_departments',
                    event.target.checked ? null : base.options.departments.map((d) => d.value),
                  )
                }
              />
              Include all current and future options
            </label>
            <div className="plugin-setting-choices">
              {base.options.departments.map((department) => (
                <label key={department.value} className="plugin-setting-choice">
                  <input
                    type="checkbox"
                    disabled={draft.driver_departments === null}
                    checked={
                      draft.driver_departments === null ||
                      draft.driver_departments.includes(department.value)
                    }
                    onChange={(event) =>
                      edit(
                        'driver_departments',
                        event.target.checked
                          ? [...draft.driver_departments!, department.value]
                          : draft.driver_departments!.filter((value) => value !== department.value),
                      )
                    }
                  />
                  {department.value || 'No department'}{' '}
                  <span className="muted">{department.count} employees</span>
                </label>
              ))}
            </div>
            {!base.options.departments.length && (
              <p>Departments will appear after the first collection.</p>
            )}
          </fieldset>
        )}
      </div>
      {tab === 'view' && (
        <>
          <p className="plugin-settings-preview">
            Name preview: {draft.name_order === 'first_last' ? 'JANE DOE' : 'DOE, JANE'}
          </p>
          <p className="plugin-settings-preview">
            Timecard column preview: Employee ·{' '}
            {draft.columns
              .map((key) => paycomColumns.find(([value]) => value === key)![1])
              .join(' · ')}
          </p>
        </>
      )}
      {tab === 'sync' && (
        <div className="paycom-settings-status">
          <p>
            Last successful sync
            <strong>
              {overview.data?.workforce.collectedAt
                ? time(overview.data.workforce.collectedAt)
                : 'Not yet synced'}
            </strong>
          </p>
          <p>
            Next scheduled sync
            <strong>
              {overview.data?.schedule.nextRun
                ? time(overview.data.schedule.nextRun)
                : 'Not scheduled'}
            </strong>
          </p>
          <div>
            <button
              onClick={() =>
                void perform(
                  () => api('/api/dsp/jobs', { requestId: crypto.randomUUID() }),
                  'Sync queued',
                )
              }
            >
              Sync now
            </button>
            <button
              onClick={() => {
                location.hash = `dsp/${dspId}/settings?tab=connections`;
              }}
            >
              Manage connection ↗
            </button>
          </div>
        </div>
      )}
      {tab !== 'drivers' && (
        <>
          <button disabled={busy} onClick={restoreSection}>
            Restore {sections.find(([key]) => key === tab)![1]} defaults
          </button>
          <div className="plugin-settings-defaults">
            <button className="text-button" disabled={busy} onClick={() => setReset(true)}>
              Restore defaults
            </button>
            <button
              className="text-button"
              aria-expanded={history}
              onClick={() => setHistory(!history)}
            >
              Change history
            </button>
            <span>Settings apply to this DSP.</span>
          </div>
          {history && (
            <section aria-label="Settings change history">
              {base.history.length ? (
                base.history.map((entry) => (
                  <div className="runtime-row" key={entry.revision}>
                    <span>
                      Revision {entry.revision} · {time(entry.at)}
                    </span>
                    <button
                      disabled={busy || newer}
                      onClick={() => setDraft(structuredClone(entry.values))}
                    >
                      Restore
                    </button>
                  </div>
                ))
              ) : (
                <p className="muted">No previous settings yet.</p>
              )}
            </section>
          )}
        </>
      )}
      <footer className="plugin-settings-footer">
        <span role="status">
          {dirty ? 'You have unsaved changes' : saved ? 'Settings saved' : 'All changes saved'}
        </span>
        <div>
          <button
            disabled={(!dirty && !newer) || busy}
            onClick={() => {
              const next = query.data ?? base;
              setBase(next);
              setDraft(structuredClone(next.values));
            }}
          >
            Discard
          </button>
          <button
            className="primary"
            disabled={!dirty || busy || newer}
            onClick={() => {
              setBusy(true);
              void perform(async () => {
                const next = await api<Snapshot>('/api/dsp/paycom/settings', {
                  revision: base.revision,
                  values: draft,
                });
                setBase(next);
                setDraft(structuredClone(next.values));
                setSaved(true);
                query.refresh();
                overview.refresh();
              }).finally(() => setBusy(false));
            }}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </footer>
      {reset && (
        <Modal title="Restore Paycom defaults?" onClose={() => setReset(false)}>
          <p>
            This replaces your draft with the default settings. Save changes to apply them to this
            DSP.
          </p>
          <div className="form-actions">
            <button onClick={() => setReset(false)}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                setDraft(structuredClone(paycomDefaults));
                setReset(false);
              }}
            >
              Restore defaults
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
