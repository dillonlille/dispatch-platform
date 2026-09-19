import { useMemo, useState } from 'react';
import { ArrowLeft, Building2, Globe2, Pencil, Plus } from 'lucide-react';
import {
  DataState,
  DataTable,
  ErrorBox,
  Header,
  useDataTable,
  type TableColumn,
} from '../../../ui/index.js';
import {
  scheduleIssues,
  type CollectionSchedule,
  type ScheduleInput,
} from '../../../../../shared/schedules.js';
import { dspHash } from '../../../app/navigation.js';
import { messageOf } from '../../../lib/errors.js';
import { LateDas } from './LateDas.js';
import { nextCollection } from './nextCollection.js';
import { ScheduleEditor } from './ScheduleEditor.js';
import './timecard-schedules.css';
import { useSchedules, getSchedules, setScheduleEnabled } from '../../../app/endpoints.js';

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
export function PaycomSettingsPage({ dspId }: { dspId: string }) {
  const query = useSchedules(dspId);
  const [editing, setEditing] = useState<CollectionSchedule | null | undefined>();
  const [busyId, setBusyId] = useState<string>();
  const [updated, setUpdated] = useState<CollectionSchedule>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const schedules = useMemo(
    () =>
      (query.data?.schedules ?? []).map((schedule) =>
        updated?.id === schedule.id && updated.revision > schedule.revision ? updated : schedule,
      ),
    [query.data, updated],
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
      const result = await setScheduleEnabled(schedule.id, !schedule.enabled, schedule.revision);
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
  const timezone = query.data?.timezone ?? 'UTC';
  const columns: TableColumn<CollectionSchedule>[] = [
    {
      id: 'schedule',
      header: 'Schedule',
      scope: 'col',
      rowHeader: true,
      hideable: false,
      value: (schedule) => schedule.name,
      cell: (schedule) => schedule.name,
    },
    {
      id: 'collection',
      header: 'Collection',
      scope: 'col',
      dataLabel: 'Collection',
      value: (schedule) => schedule.collection,
      cell: (schedule) => <CollectionLabels collection={schedule.collection} />,
    },
    {
      id: 'repeat',
      header: 'Repeat',
      scope: 'col',
      dataLabel: 'Repeat',
      value: repeat,
      cell: repeat,
    },
    {
      id: 'next',
      header: 'Next collection',
      scope: 'col',
      dataLabel: 'Next collection',
      className: 'schedule-next',
      value: (schedule) => schedule.nextRun,
      cell: (schedule) => (
        <>
          {schedule.enabled ? nextCollection(schedule.nextRun, timezone) : 'Paused'}
          {schedule.lastError && (
            <small>
              {scheduleIssues[schedule.lastError] ?? 'Collection delayed. Check connections.'}
            </small>
          )}
        </>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      scope: 'col',
      dataLabel: 'Status',
      value: (schedule) => (schedule.enabled ? 'On' : 'Paused'),
      cell: (schedule) => (
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
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      name: 'Actions',
      scope: 'col',
      hideable: false,
      className: 'schedule-row-actions',
      cell: (schedule) => (
        <button
          className="icon-button"
          aria-label={`Edit ${schedule.name}`}
          onClick={() => setEditing(schedule)}
        >
          <Pencil size={16} aria-hidden="true" />
        </button>
      ),
    },
  ];
  const table = useDataTable({ columns, rows: schedules, rowId: (schedule) => schedule.id });
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
                <DataTable table={table} className="schedule-table" caption="Sync schedules" />
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
                  const fresh = await getSchedules();
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
