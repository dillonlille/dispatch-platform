import { useMemo, useState } from 'react';
import type { Job } from '../../shared/contracts/index.js';
import { collectionHistory } from './collection-history.js';
import { duration, memory } from './job-performance.js';
import { Badge, DetailList } from './ui/index.js';
import { time, deviceTimezone } from './lib/format.js';

export function CollectionHistory({ jobs }: { jobs: Job[] }) {
  const groups = useMemo(() => collectionHistory(jobs), [jobs]);
  const [selected, setSelected] = useState('');
  const group = groups.find((g) => g.key === selected) ?? groups[0];
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
        <table>
          <caption className="sr-only">Last ten completed collections for {group.label}</caption>
          <thead>
            <tr>
              <th>Finished</th>
              <th>Status</th>
              <th>Collection time</th>
              <th>Retries</th>
              <th>Peak browser memory</th>
              <th>Resumed employees</th>
            </tr>
          </thead>
          <tbody>
            {group.runs.slice(0, 10).map((run) => (
              <tr key={run.job.id}>
                <td>{time(run.job.completedAt ?? run.job.createdAt, deviceTimezone())}</td>
                <td>
                  <Badge value={run.job.status} />
                </td>
                <td>
                  {duration(run.collectionMs)}
                  {run.partial && <small>Partial timing before interruption</small>}
                </td>
                <td>
                  {run.pageRetries} page · {run.jobRetries} job
                </td>
                <td>{memory(run.peakBytes)}</td>
                <td>{run.resumed || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
