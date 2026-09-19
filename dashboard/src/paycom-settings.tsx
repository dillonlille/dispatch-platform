import { useEffect, useState } from 'react';
import { ArrowLeft, Building2, Globe2, Pencil, Plus } from 'lucide-react';
import { api, ApiError, useData } from './api.js';
import { DataState, ErrorBox, Header, Modal } from './ui/index.js';
import { dateFormatter } from '../../shared/date-format.js';
import {
  scheduleIssues,
  type CollectionSchedule,
  type CollectionSchedules,
  type ScheduleInput,
} from '../../shared/schedules.js';
import type { PaycomSettings } from '../../shared/paycom.js';
import { dspHash } from './app/navigation.js';
import { messageOf } from './lib/errors.js';
import './timecard-schedules.css';

const newSchedule = (): ScheduleInput => ({
  name: '',
  collection: 'paycom',
  cadence: 'interval',
  intervalMinutes: 120,
  localTime: '00:00',
  enabled: true,
});
function clock(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return `${hour! % 12 || 12}:${String(minute).padStart(2, '0')} ${hour! < 12 ? 'AM' : 'PM'}`;
}
function repeat(schedule: ScheduleInput) {
  if (schedule.cadence === 'daily') return `Daily at ${clock(schedule.localTime)}`;
  const minutes = schedule.intervalMinutes ?? 120;
  return minutes % 60 === 0
    ? `Every ${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
    : `Every ${minutes} minutes`;
}
function nextCollection(value: string | null, timezone: string) {
  return value
    ? dateFormatter('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
      }).format(new Date(value))
    : 'Not scheduled';
}
function CollectionLabels({ collection }: Pick<ScheduleInput, 'collection'>) {
  return (
    <div className="schedule-collections">
      {collection !== 'meal_break' && <span className="schedule-tag">Paycom</span>}
      {collection !== 'paycom' && (
        <span className="schedule-tag schedule-tag-meal">Meal Break</span>
      )}
    </div>
  );
}
function ScheduleEditor({
  schedule,
  timezone,
  onClose,
  onSaved,
  onReload,
}: {
  schedule: CollectionSchedule | null;
  timezone: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onReload: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ScheduleInput>(() =>
    schedule
      ? {
          name: schedule.name,
          collection: schedule.collection,
          cadence: schedule.cadence,
          intervalMinutes: schedule.intervalMinutes,
          localTime: schedule.localTime,
          enabled: schedule.enabled,
        }
      : newSchedule(),
  );
  const [paycom, setPaycom] = useState(draft.collection !== 'meal_break');
  const [meal, setMeal] = useState(draft.collection !== 'paycom');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');
  const { cadence, intervalMinutes, localTime, enabled } = draft;
  const sameTiming =
    !!schedule &&
    schedule.cadence === cadence &&
    schedule.intervalMinutes === intervalMinutes &&
    schedule.localTime === localTime;
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setPreviewError('');
    if (
      !enabled ||
      !localTime ||
      (cadence === 'interval' &&
        (!intervalMinutes ||
          intervalMinutes < 30 ||
          intervalMinutes > 1440 ||
          intervalMinutes % 30))
    )
      return;
    if (sameTiming && schedule.enabled && schedule.nextRun) {
      setPreview(schedule.nextRun);
      return;
    }
    const timer = setTimeout(() => {
      void api<{ nextRun: string }>(
        '/api/dsp/schedules/preview',
        {
          cadence,
          intervalMinutes,
          localTime,
          ...(schedule ? { scheduleId: schedule.id } : {}),
        },
        controller.signal,
      )
        .then((result) => setPreview(result.nextRun))
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setPreviewError(messageOf(cause));
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cadence, intervalMinutes, localTime, enabled, timezone, sameTiming, schedule]);
  const edit = <K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function submit(remove = false) {
    if (!remove && !paycom && !meal) {
      setError('Select Paycom, Meal Break, or both.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (remove && schedule)
        await api(`/api/dsp/schedules/${schedule.id}/remove`, { revision: schedule.revision });
      else
        await api(schedule ? `/api/dsp/schedules/${schedule.id}` : '/api/dsp/schedules', {
          ...draft,
          name: draft.name.trim(),
          collection: paycom && meal ? 'both' : paycom ? 'paycom' : 'meal_break',
          ...(schedule ? { revision: schedule.revision } : {}),
        });
      onSaved(remove ? 'Schedule deleted' : schedule ? 'Schedule saved' : 'Schedule created');
    } catch (cause) {
      setError(messageOf(cause));
      setStale(cause instanceof ApiError && cause.code === 'schedule_changed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={schedule ? 'Edit schedule' : 'New schedule'}
      variant="sheet"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="schedule-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="schedule-editor-fields">
          <label>
            Schedule name
            <input
              autoComplete="off"
              value={draft.name}
              placeholder="e.g. Morning collection"
              required
              maxLength={60}
              onChange={(event) => edit('name', event.target.value)}
            />
          </label>
          <fieldset className="schedule-choice-group">
            <legend>Collect</legend>
            <div className="schedule-checks">
              <label>
                <input
                  type="checkbox"
                  checked={paycom}
                  onChange={(event) => setPaycom(event.target.checked)}
                />
                Paycom
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={meal}
                  onChange={(event) => setMeal(event.target.checked)}
                />
                Meal Break
              </label>
            </div>
          </fieldset>
          <fieldset className="schedule-choice-group">
            <legend>Repeat</legend>
            <div className="schedule-repeat">
              <label>
                <input
                  type="radio"
                  name="schedule-repeat"
                  value="interval"
                  checked={cadence === 'interval'}
                  onChange={() =>
                    setDraft((current) => ({
                      ...current,
                      cadence: 'interval',
                      intervalMinutes: 120,
                    }))
                  }
                />
                Every interval
              </label>
              <label>
                <input
                  type="radio"
                  name="schedule-repeat"
                  value="daily"
                  checked={cadence === 'daily'}
                  onChange={() =>
                    setDraft((current) => ({ ...current, cadence: 'daily', intervalMinutes: null }))
                  }
                />
                Daily
              </label>
            </div>
          </fieldset>
          <div className={cadence === 'interval' ? 'schedule-time-fields' : undefined}>
            {cadence === 'interval' && (
              <label>
                Every
                <div className="schedule-interval">
                  <input
                    type="number"
                    aria-label="Every"
                    aria-describedby="schedule-hours"
                    min="0.5"
                    max="24"
                    step="0.5"
                    required
                    value={intervalMinutes ? intervalMinutes / 60 : ''}
                    onChange={(event) => edit('intervalMinutes', Number(event.target.value) * 60)}
                  />
                  <span id="schedule-hours">hours</span>
                </div>
              </label>
            )}
            <label>
              {cadence === 'interval' ? 'Starting at' : 'Time'}
              <input
                type="time"
                value={localTime}
                required
                onChange={(event) => edit('localTime', event.target.value)}
              />
            </label>
          </div>
          <div className="schedule-timezone">
            <Globe2 size={14} aria-hidden="true" />
            {timezone} · DSP time zone
          </div>
          <div className="schedule-next-preview">
            <span>Next collection</span>
            <output aria-live="polite">
              {enabled ? (preview ? nextCollection(preview, timezone) : '—') : 'Paused'}
            </output>
          </div>
          <ErrorBox message={previewError} />
        </fieldset>
        <ErrorBox message={error} />
        {stale && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void onReload().catch((cause) => setError(messageOf(cause)));
            }}
          >
            Reload schedule
          </button>
        )}
        <div className="schedule-editor-actions">
          <label className="schedule-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={enabled}
              disabled={busy}
              onChange={(event) => edit('enabled', event.target.checked)}
            />
            Enabled
          </label>
          <div>
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy || stale} type="submit">
              {busy ? 'Saving…' : schedule ? 'Save changes' : 'Create schedule'}
            </button>
          </div>
        </div>
        {schedule &&
          (deleting ? (
            <div
              className="schedule-delete-confirm"
              role="group"
              aria-label="Delete schedule confirmation"
            >
              <span>Delete this schedule?</span>
              <div>
                <button type="button" disabled={busy} onClick={() => setDeleting(false)}>
                  Keep schedule
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || stale}
                  onClick={() => void submit(true)}
                >
                  Delete schedule
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-button danger schedule-delete"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              Delete schedule
            </button>
          ))}
      </form>
    </Modal>
  );
}
function LateDas({
  dspId,
  onSaved,
  onError,
}: {
  dspId: string;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const query = useData<PaycomSettings>('/api/dsp/paycom/settings', 0, dspId, dspId);
  const [saved, setSaved] = useState<PaycomSettings>();
  const [draft, setDraft] = useState<{ time: string; departments: string[] }>();
  const [busy, setBusy] = useState(false);
  const settings =
    saved && saved.revision >= (query.data?.revision ?? 0) ? saved : (query.data ?? saved);
  if (!settings) return null;
  const current = {
    time: settings.values.late_da_time,
    departments: settings.values.late_da_departments,
  };
  const { time, departments } = draft ?? current;
  const dirty =
    time !== current.time ||
    [...departments].sort().join('\n') !== [...current.departments].sort().join('\n');
  // Keep a saved department that left the roster visible so it can be cleared.
  const options = [
    ...settings.options.departments,
    ...current.departments
      .filter((value) => !settings.options.departments.some((d) => d.value === value))
      .map((value) => ({ value, count: 0 })),
  ];
  async function save() {
    setBusy(true);
    onError('');
    try {
      setSaved(
        await api<PaycomSettings>('/api/dsp/paycom/settings', {
          revision: settings!.revision,
          // The backend requires every stored preference back, including ones not edited here.
          values: { ...settings!.values, late_da_time: time, late_da_departments: departments },
        }),
      );
      setDraft(undefined);
      onSaved('Late DAs saved');
    } catch (cause) {
      onError(messageOf(cause));
      query.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="late-das" aria-labelledby="late-das-heading">
      <div className="schedule-section-heading">
        <div>
          <h2 id="late-das-heading">Late DAs</h2>
        </div>
        {dirty && (
          <div className="late-das-actions">
            <button disabled={busy} onClick={() => setDraft(undefined)}>
              Discard
            </button>
            <button className="primary" disabled={busy || !time} onClick={() => void save()}>
              Save
            </button>
          </div>
        )}
      </div>
      <div className="late-das-card">
        <label className="late-das-field">
          <span>Late at or after</span>
          <input
            type="time"
            required
            value={time}
            disabled={busy}
            onChange={(event) => setDraft({ time: event.target.value, departments })}
          />
        </label>
        <fieldset className="late-das-field" disabled={busy}>
          <legend>Departments</legend>
          {options.length ? (
            <div className="late-das-departments">
              {options.map((department) => (
                <label key={department.value}>
                  <input
                    type="checkbox"
                    checked={departments.includes(department.value)}
                    onChange={(event) =>
                      setDraft({
                        time,
                        departments: event.target.checked
                          ? [...departments, department.value]
                          : departments.filter((value) => value !== department.value),
                      })
                    }
                  />
                  {department.value || 'No department'}
                  <small>{department.count}</small>
                </label>
              ))}
            </div>
          ) : (
            <p>Departments appear after the first collection.</p>
          )}
        </fieldset>
      </div>
    </section>
  );
}
export function PaycomSettingsPage({ dspId }: { dspId: string }) {
  const query = useData<CollectionSchedules>('/api/dsp/schedules', 10000, dspId, dspId);
  const [editing, setEditing] = useState<CollectionSchedule | null | undefined>();
  const [busyId, setBusyId] = useState<string>();
  const [updated, setUpdated] = useState<CollectionSchedule>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const schedules = (query.data?.schedules ?? []).map((schedule) =>
    updated?.id === schedule.id && updated.revision > schedule.revision ? updated : schedule,
  );
  const active = schedules.filter((schedule) => schedule.enabled).length;
  async function toggle(schedule: CollectionSchedule) {
    setBusyId(schedule.id);
    setError('');
    setUpdated({
      ...schedule,
      enabled: !schedule.enabled,
      nextRun: null,
      revision: schedule.revision + 1,
    });
    try {
      const result = await api<CollectionSchedule>(`/api/dsp/schedules/${schedule.id}/enabled`, {
        enabled: !schedule.enabled,
        revision: schedule.revision,
      });
      setUpdated(result);
      setMessage(schedule.enabled ? 'Schedule paused' : 'Schedule enabled');
    } catch (cause) {
      setUpdated(undefined);
      setError(messageOf(cause));
    } finally {
      query.refresh();
      setBusyId(undefined);
    }
  }
  return (
    <div className="timecard-schedules">
      <a className="schedule-back" href={dspHash(dspId, 'paycom')}>
        <ArrowLeft size={14} aria-hidden="true" />
        Back
      </a>
      <Header title="Timecard Settings">
        <button className="primary" disabled={!query.data} onClick={() => setEditing(null)}>
          <Plus size={16} aria-hidden="true" />
          New schedule
        </button>
      </Header>
      <ErrorBox message={error || query.error} />
      <DataState data={query.data} failed={Boolean(query.error)}>
        {(data) => (
          <>
            <div className="schedule-section-heading">
              <div>
                <h2>Sync schedules</h2>
                <span className="schedule-count">{schedules.length}</span>
              </div>
              <span className="schedule-timezone">
                <Globe2 size={14} aria-hidden="true" />
                DSP time zone · {data.timezone}
              </span>
            </div>
            {schedules.length ? (
              <div className="schedule-table-wrap">
                <table className="schedule-table">
                  <caption className="sr-only">Sync schedules</caption>
                  <thead>
                    <tr>
                      <th scope="col">Schedule</th>
                      <th scope="col">Collection</th>
                      <th scope="col">Repeat</th>
                      <th scope="col">Next collection</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedules.map((schedule) => (
                      <tr key={schedule.id}>
                        <th scope="row">{schedule.name}</th>
                        <td data-label="Collection">
                          <CollectionLabels collection={schedule.collection} />
                        </td>
                        <td data-label="Repeat">{repeat(schedule)}</td>
                        <td data-label="Next collection" className="schedule-next">
                          {schedule.enabled
                            ? nextCollection(schedule.nextRun, data.timezone)
                            : 'Paused'}
                          {schedule.lastError && (
                            <small>
                              {scheduleIssues[schedule.lastError] ??
                                'Collection delayed. Check connections.'}
                            </small>
                          )}
                        </td>
                        <td data-label="Status">
                          <label className="schedule-toggle">
                            <input
                              type="checkbox"
                              role="switch"
                              aria-label={`Enable ${schedule.name}`}
                              checked={schedule.enabled}
                              disabled={busyId !== undefined}
                              onChange={() => void toggle(schedule)}
                            />
                            <span>{schedule.enabled ? 'On' : 'Paused'}</span>
                          </label>
                        </td>
                        <td className="schedule-row-actions">
                          <button
                            className="icon-button"
                            aria-label={`Edit ${schedule.name}`}
                            onClick={() => setEditing(schedule)}
                          >
                            <Pencil size={16} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="schedule-empty">
                <h3>No schedules</h3>
                <button onClick={() => setEditing(null)}>
                  <Plus size={16} aria-hidden="true" />
                  New schedule
                </button>
              </div>
            )}
            <LateDas dspId={dspId} onSaved={setMessage} onError={setError} />
            <footer className="schedule-footer">
              <span>
                <Building2 size={14} aria-hidden="true" />
                Applies to {data.dspName}
              </span>
              <span role="status">
                {message || `${active} ${active === 1 ? 'schedule' : 'schedules'} active`}
              </span>
            </footer>
            {editing !== undefined && (
              <ScheduleEditor
                key={`${editing?.id ?? 'new'}-${editing?.revision ?? 0}`}
                schedule={editing}
                timezone={data.timezone}
                onClose={() => setEditing(undefined)}
                onSaved={(text) => {
                  setEditing(undefined);
                  setMessage(text);
                  query.refresh();
                }}
                onReload={async () => {
                  const fresh = await api<CollectionSchedules>('/api/dsp/schedules');
                  const schedule = fresh.schedules.find((value) => value.id === editing?.id);
                  setEditing(schedule);
                  query.refresh();
                }}
              />
            )}
          </>
        )}
      </DataState>
    </div>
  );
}
