import { AlertTriangle, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { useMemo } from 'react';
import { errorLabel } from '../../../app/api.js';
import {
  Badge,
  DataTable,
  DetailList,
  downloadTable,
  Empty,
  TablePagination,
  useDataTable,
  type TableColumn,
} from '../../../ui/index.js';
import { deviceTimezone, duration, time, title } from '../../../lib/format.js';
import {
  isUnderway,
  providerName,
  type CollectionRun as Run,
  type CollectionSource as Source,
} from './collection-history.js';
import { memory, RunDetail } from './RunDetail.js';
import { TrendChart } from './TrendChart.js';

const finished = (run: Run) => run.job.completedAt ?? run.job.createdAt;

const columns: TableColumn<Run>[] = [
  {
    id: 'finished',
    header: 'Finished',
    rowHeader: true,
    value: finished,
    cell: (run, { expanded, toggle }) => (
      <button className="run-toggle" aria-expanded={expanded} onClick={toggle}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span>
          {time(finished(run), deviceTimezone())}
          {!run.job.completedAt && <small>Requested</small>}
        </span>
      </button>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    value: (run) => run.job.status,
    cell: ({ job }) => (
      <>
        <Badge value={job.status} />
        {job.error && <small>{errorLabel(job.error) ?? title(job.error)}</small>}
        {isUnderway(job.status) && (
          <small>
            {job.progress}% · {job.message}
          </small>
        )}
      </>
    ),
  },
  {
    id: 'time',
    header: 'Collection time',
    value: (run) => run.collectionMs,
    cell: (run) => (
      <>
        {duration(run.collectionMs)}
        {run.partial && <small>Partial timing before interruption</small>}
      </>
    ),
  },
  {
    id: 'memory',
    header: 'Peak browser memory',
    value: (run) => run.peakBytes,
    cell: (run) => memory(run.peakBytes),
  },
  {
    id: 'attempts',
    header: 'Attempts',
    value: (run) => run.job.attempt,
    cell: (run) => run.job.attempt,
  },
];

export function DiagnosticsCollections({
  sources,
  selected,
  run,
  onSelect,
}: {
  sources: Source[];
  selected: string;
  /** A run to show expanded, from a link elsewhere in Diagnostics. */
  run?: string;
  onSelect: (key: string) => void;
}) {
  const source = sources.find((s) => s.key === selected) ?? sources[0];
  const runs = useMemo(() => source?.runs ?? [], [source]);
  // A collection still underway leads the list; the charts and statistics leave it out.
  const rows = useMemo(() => [...(source?.underway ?? []), ...runs], [source, runs]);
  const table = useDataTable({
    columns,
    rows,
    rowId: (row) => row.job.id,
    pageSize: 20,
    expanded: run ? [run] : undefined,
  });
  if (!source)
    return <Empty title="No collections yet">Start a collection from a DSP workspace.</Empty>;
  const trend = runs
    .filter((run) => run.job.status === 'succeeded' && run.collectionMs !== null)
    .slice(0, 10)
    .reverse();
  const label = (run: Run) => time(run.job.completedAt, deviceTimezone());
  const memoryTrend = trend.filter((run) => run.peakBytes !== null);
  // Fixture and cached collections finish in milliseconds; real ones take minutes.
  const longest = Math.max(0, ...trend.map((run) => run.collectionMs!));
  const [unit, scale] =
    longest >= 60000
      ? (['minutes', 60000] as const)
      : longest >= 1000
        ? (['seconds', 1000] as const)
        : (['milliseconds', 1] as const);
  return (
    <div className="diagnostics-collections">
      <nav className="diagnostics-sources" aria-label="Collection sources">
        {sources.map(({ key, newest, warnings }) => (
          <button
            key={key}
            aria-current={key === source.key ? 'true' : undefined}
            onClick={() => onSelect(key)}
          >
            <span>
              <strong>{newest.dspName}</strong>
              <small>
                {providerName(newest.kind)} ·{' '}
                {isUnderway(newest.status)
                  ? `${newest.progress}%`
                  : time(newest.completedAt, deviceTimezone(), '—')}
              </small>
            </span>
            {warnings.length > 0 && (
              <AlertTriangle size={16} className="diagnostics-warn" aria-label="Needs attention" />
            )}
            <Badge value={newest.status} />
          </button>
        ))}
      </nav>
      <section aria-label="Collection performance history">
        <div className="diagnostics-source-heading">
          <h2>{source.label}</h2>
          <DetailList
            className="diagnostics-source-stats"
            items={[
              ['Median collection time', duration(source.medianMs)],
              [
                '95th percentile',
                source.samples < 5 ? 'Needs 5 full runs' : duration(source.p95Ms),
              ],
              ['Full runs measured', source.samples],
            ]}
          />
        </div>
        {source.warnings.map((warning) => (
          <p className="diagnostics-warning" key={warning}>
            <AlertTriangle size={16} aria-hidden="true" />
            {warning}
          </p>
        ))}
        {trend.length > 1 && (
          <div className="diagnostics-pair">
            <TrendChart
              title="Collection time"
              unit={unit}
              scale={scale}
              format={duration}
              median={source.medianMs}
              points={trend.map((run) => ({
                id: run.job.id,
                label: label(run),
                value: run.collectionMs!,
              }))}
            />
            {memoryTrend.length > 1 && (
              <TrendChart
                title="Peak browser memory"
                unit="MiB"
                scale={1024 ** 2}
                format={memory}
                points={memoryTrend.map((run) => ({
                  id: run.job.id,
                  label: label(run),
                  value: run.peakBytes!,
                }))}
              />
            )}
          </div>
        )}
        <section className="diagnostics-card" aria-label="Platform collections">
          <div className="diagnostics-card-heading">
            <h2>Runs</h2>
            <button
              className="text-button"
              onClick={() =>
                downloadTable(table, `collections-${source.label.replace(/\W+/g, '-')}.csv`)
              }
            >
              <Download size={16} />
              Export CSV
            </button>
          </div>
          {rows.length ? (
            <div className="table-wrap">
              <DataTable
                table={table}
                className="diagnostics-runs"
                caption={`Collections for ${source.label}`}
                rowClassName={(_, { expanded }) => (expanded ? 'run-open' : undefined)}
                renderDetail={(run) => <RunDetail job={run.job} />}
                detailClassName="run-detail-row"
              />
              <TablePagination table={table} />
            </div>
          ) : (
            <p className="muted">No collection has run for this source yet.</p>
          )}
        </section>
      </section>
    </div>
  );
}
