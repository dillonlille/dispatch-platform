import { useState } from 'react';
import { api, useData } from '../../../app/api.js';
import type { PaycomSettings } from '../../../../../shared/paycom.js';
import { messageOf } from '../../../lib/errors.js';

export function LateDas({
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
