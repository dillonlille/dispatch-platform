import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import type { Job, JobMetrics } from '../../../../../shared/contracts/index.js';
import { errorLabel } from '../../../app/api.js';
import { DetailList } from '../../../ui/index.js';
import { bytes, duration, title } from '../../../lib/format.js';

export const memory = (value: number | null) =>
  value === null ? 'Not sampled' : bytes(value, 'MiB', 1);

const phases: [label: string, tone: string, read: (attempt: JobMetrics) => number | null][] = [
  ['Queue wait', 'phase-queue', (attempt) => attempt.queueMs],
  ['Browser & sign-in', 'phase-sign-in', (attempt) => attempt.authenticationMs],
  ['Human verification', 'phase-verification', (attempt) => attempt.verificationMs],
  ['Collection', 'phase-collection', (attempt) => attempt.collectionMs],
  ['Publishing', 'phase-publishing', (attempt) => attempt.publicationMs],
];

/** One collection's attempts: where the time went, memory, records and page reads. */
export function RunDetail({ job }: { job: Job }) {
  const metrics = job.metrics ?? [];
  const [chosen, setChosen] = useState<number>();
  const attempt = metrics.find((m) => m.attempt === chosen) ?? metrics.at(-1);
  if (!attempt) return <p className="muted">Performance was not recorded for this collection.</p>;
  const reads = attempt.pageReads;
  return (
    <div className="run-detail">
      {metrics.length > 1 && (
        <div className="diagnostics-chips" role="group" aria-label="Attempts">
          {metrics.map((m) => (
            <button
              key={m.attempt}
              aria-pressed={m === attempt}
              onClick={() => setChosen(m.attempt)}
            >
              Attempt {m.attempt} · {title(m.outcome)}
            </button>
          ))}
        </div>
      )}
      <section aria-label={`Attempt ${attempt.attempt}`}>
        {attempt.error && (
          <p className="run-error">
            {errorLabel(attempt.error) ?? title(attempt.error)}
            {attempt.detail && ` · ${title(attempt.detail)}`}
          </p>
        )}
        <h3>Where the time went</h3>
        <div className="run-phases" aria-hidden="true">
          {phases.map(([label, tone, read]) =>
            read(attempt) ? (
              <span key={label} className={tone} style={{ flexGrow: read(attempt)! }} />
            ) : null,
          )}
        </div>
        <dl className="run-phase-legend">
          {phases.map(([label, tone, read]) => (
            <div key={label}>
              <dt>
                <i className={tone} />
                {label}
              </dt>
              <dd>{duration(read(attempt))}</dd>
            </div>
          ))}
        </dl>
        {attempt.outcome === 'interrupted' && (
          <p className="muted">Timings stop at the last saved measurement before interruption.</p>
        )}
        <h3>Memory and records</h3>
        <DetailList
          className="run-facts"
          items={[
            ['Elapsed', duration(attempt.elapsedMs)],
            ['Peak private memory', memory(attempt.peakPrivateBytes)],
            ['Peak summed memory (RSS)', memory(attempt.peakRssBytes)],
            [
              'Collected',
              attempt.employees === null
                ? '—'
                : `${attempt.employees} employees · ${attempt.timecards} daily records`,
            ],
            ...(reads
              ? ([
                  [
                    'Timecards validated',
                    `${reads.completed} · ${reads.direct ?? 0} without rendering · ${reads.spotChecked ?? 0} spot-checked · ${reads.earlyReady ?? 0} ready before full page load`,
                  ],
                  [
                    'Page retries',
                    `${reads.retries} · ${reads.recovered} recovered · ${reads.resumed ?? 0} resumed`,
                  ],
                ] as [string, string][])
              : []),
            [
              'Memory samples',
              `${attempt.memorySamples} · ${attempt.incompleteMemorySamples} incomplete`,
            ],
          ]}
        />
        {reads && (reads.active.length > 0 || reads.failures.length > 0 || reads.slowest[0]) && (
          <div aria-label="Timecard diagnostics">
            <h3>Slow and failed reads</h3>
            <ul className="run-reads">
              {reads.active.map((page) => (
                <li key={`active-${page.ordinal}`}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  Employee {page.ordinal} · {title(page.stage)} · {duration(page.elapsedMs)}
                  {attempt.outcome !== 'running' && ' at interruption'}
                </li>
              ))}
              {reads.failures.map((page) => (
                <li key={`${page.ordinal}-${page.attempt}`}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  Employee {page.ordinal}, read {page.attempt} · {title(page.stage)} ·{' '}
                  {title(page.error ?? '')} after {duration(page.elapsedMs)}
                  {page.documentState && ` · document ${page.documentState}`}
                  {page.pendingRequests != null &&
                    ` · ${page.pendingRequests} data requests pending`}
                </li>
              ))}
            </ul>
            {reads.slowest[0] && (
              <p className="muted">
                Slowest read: employee {reads.slowest[0].ordinal} · navigation{' '}
                {duration(reads.slowest[0].navigationMs)}, page content{' '}
                {duration(reads.slowest[0].contentMs)}, extraction{' '}
                {duration(reads.slowest[0].extractionMs)}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
