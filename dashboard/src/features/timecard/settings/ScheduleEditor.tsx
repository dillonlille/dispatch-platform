import { useEffect, useState } from 'react';
import { Globe2 } from 'lucide-react';
import { api, ApiError } from '../../../app/api.js';
import { ErrorBox, Modal } from '../../../ui/index.js';
import type {
  CollectionSchedule,
  ScheduleInput,
} from '../../../../../shared/contracts/schedules.js';
import { messageOf } from '../../../lib/errors.js';
import { nextCollection } from './nextCollection.js';
import { saveSchedule, removeSchedule } from '../../../app/endpoints.js';

const newSchedule = (): ScheduleInput => ({
  name: '',
  collection: 'paycom',
  cadence: 'interval',
  intervalMinutes: 120,
  localTime: '00:00',
  enabled: true,
});
export function ScheduleEditor({
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
      if (remove && schedule) await removeSchedule(schedule.id, schedule.revision);
      else
        await saveSchedule(schedule?.id, {
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
