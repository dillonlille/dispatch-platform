import { useMemo, useState } from 'react';
import type { Job } from '../../../../shared/contracts/index.js';
import { collectionHistory } from './collection-history.js';
import { memory } from './JobPerformance.js';
import { Badge, DataTable, DetailList, useDataTable, type TableColumn } from '../../ui/index.js';
import { deviceTimezone, duration, time } from '../../lib/format.js';

type Run = ReturnType<typeof collectionHistory>[number]['runs'][number];
const columns: TableColumn<Run>[] = [
  {
    id: 'finished',
    header: 'Finished',
    value: (run) => run.job.completedAt ?? run.job.createdAt,
    cell: (run) => time(run.job.completedAt ?? run.job.createdAt, deviceTimezone()),
  },
  {
    id: 'status',
    header: 'Status',
    value: (run) => run.job.status,
    cell: (run) => <Badge value={run.job.status} />,
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
    id: 'retries',
    header: 'Retries',
    value: (run) => run.pageRetries + run.jobRetries,
    cell: (run) => (
      <>
        {run.pageRetries} page · {run.jobRetries} job
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
    id: 'resumed',
    header: 'Resumed employees',
    value: (run) => run.resumed,
    cell: (run) => run.resumed || '—',
  },
];

export function CollectionHistory({ jobs }: { jobs: Job[] }) {
  const groups = useMemo(() => collectionHistory(jobs), [jobs]);
  const [selected, setSelected] = useState('');
  const group = groups.find((g) => g.key === selected) ?? groups[0];
  const recent = useMemo(() => group?.runs.slice(0, 10) ?? [], [group]);
  const table = useDataTable({ columns, rows: recent, rowId: (run) => run.job.id });
  if (!group) return null;
  const trend = group.runs
    .filter((r) => r.job.status === 'succeeded' && r.collectionMs !== null)
    .slice(0, 10)
    .reverse();
  const maximum = Math.max(1, ...trend.map((r) => r.collectionMs!));
  const last = group.latest?.job.completedAt;
  return (
    <section
      className="collection-history archived-card"
      aria-label="Collection performance history"
    >
      <div className="collection-history-heading">
        <div>
          <h2>Performance history</h2>
          <p className="muted">Recent collections, grouped by DSP and provider.</p>
        </div>
        <label>
          Collection source
          <select value={group.key} onChange={(e) => setSelected(e.target.value)}>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DetailList
        className="collection-history-stats"
        items={[
          [
            'Last successful collection',
            last ? time(last, deviceTimezone()) : 'None in this history',
          ],
          ['Median collection time', duration(group.medianMs)],
          ['95th percentile', group.samples < 5 ? 'Needs 5 full runs' : duration(group.p95Ms)],
          ['Full runs measured', group.samples],
        ]}
      />
      {group.warnings.map((warning) => (
        <p className="notice" key={warning}>
          {warning}
        </p>
      ))}
      {trend.length > 1 && (
        <figure className="collection-history-trend">
          <svg
            viewBox="0 0 600 80"
            role="img"
            aria-label="Collection time across the last ten successful runs, oldest to newest"
          >
            <line x1="8" y1="72" x2="592" y2="72" />
            <polyline
              points={trend
                .map(
                  (r, i) =>
                    `${8 + (i * 584) / (trend.length - 1)},${72 - (r.collectionMs! / maximum) * 64}`,
                )
                .join(' ')}
            />
            {trend.map((r, i) => (
              <circle
                key={r.job.id}
                cx={8 + (i * 584) / (trend.length - 1)}
                cy={72 - (r.collectionMs! / maximum) * 64}
                r="3"
              >
                <title>
                  {time(r.job.completedAt!, deviceTimezone())}: {duration(r.collectionMs)}
                </title>
              </circle>
            ))}
          </svg>
          <figcaption>
            Collection time · oldest to newest · scale 0–{duration(maximum)}. Values appear below.
          </figcaption>
        </figure>
      )}
      <div className="table-wrap">
        <DataTable table={table} caption={`Last ten completed collections for ${group.label}`} />
      </div>
      <p className="muted">
        Based on up to 200 recent jobs. Collection time sums recorded attempts and excludes sign-in,
        verification and queue wait. Summary statistics use up to 20 successful full runs; speed
        comparisons use time per employee or itinerary and exclude resumed or retried jobs. Memory
        is sampled PSS, which accounts for shared browser pages.
      </p>
    </section>
  );
}
