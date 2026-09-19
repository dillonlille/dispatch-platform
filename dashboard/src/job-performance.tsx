import { useState } from 'react';
import type { JobMetrics } from '../../shared/contracts/index.js';
import { bytes, duration, title } from './lib/format.js';

export const memory = (value: number | null) =>
  value === null ? 'Not sampled' : bytes(value, 'MiB', 1);
export function JobPerformance({ metrics = [] }: { metrics: JobMetrics[] }) {
  const [expanded, setExpanded] = useState(false);
  const latest = metrics.at(-1);
  if (!latest) return <small>Not recorded</small>;
  return (
    <div className="job-performance">
      <strong>{duration(latest.elapsedMs)} elapsed</strong>
      <small>
        {latest.peakPssBytes === null
          ? 'Browser memory not sampled'
          : `${memory(latest.peakPssBytes)} peak browser memory`}
      </small>
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>Attempt details</summary>
        {expanded && (
          <div className="job-attempts">
            {metrics.map((attempt) => (
              <section key={attempt.attempt} aria-label={`Attempt ${attempt.attempt}`}>
                <strong>
                  Attempt {attempt.attempt} · {title(attempt.outcome)}
                </strong>
                {attempt.error && (
                  <small>
                    {title(attempt.error)}
                    {attempt.detail && ` · ${title(attempt.detail)}`}
                  </small>
                )}
                <dl>
                  <dt>Queue wait</dt>
                  <dd>{duration(attempt.queueMs)}</dd>
                  <dt>Browser & sign-in</dt>
                  <dd>{duration(attempt.authenticationMs)}</dd>
                  <dt>Human verification</dt>
                  <dd>{duration(attempt.verificationMs)}</dd>
                  <dt>Collection</dt>
                  <dd>{duration(attempt.collectionMs)}</dd>
                  <dt>Publishing</dt>
                  <dd>{duration(attempt.publicationMs)}</dd>
                  <dt>Elapsed</dt>
                  <dd>{duration(attempt.elapsedMs)}</dd>
                  <dt>Peak browser memory</dt>
                  <dd>{memory(attempt.peakPssBytes)}</dd>
                  <dt>Peak private memory</dt>
                  <dd>{memory(attempt.peakPrivateBytes)}</dd>
                  <dt>Peak summed memory (RSS)</dt>
                  <dd>{memory(attempt.peakRssBytes)}</dd>
                  <dt>Collected records</dt>
                  <dd>
                    {attempt.employees === null
                      ? '—'
                      : `${attempt.employees} employees · ${attempt.timecards} daily records`}
                  </dd>
                </dl>
                {attempt.pageReads && (
                  <div aria-label="Timecard diagnostics">
                    <p>
                      {attempt.pageReads.completed} timecards validated ·{' '}
                      {attempt.pageReads.direct ?? 0} without rendering ·{' '}
                      {attempt.pageReads.spotChecked ?? 0} spot-checked ·{' '}
                      {attempt.pageReads.retries} page retries · {attempt.pageReads.recovered}{' '}
                      recovered · {attempt.pageReads.resumed ?? 0} resumed ·{' '}
                      {attempt.pageReads.earlyReady ?? 0} ready before full page load
                    </p>
                    {attempt.pageReads.active.map((page) => (
                      <small key={page.ordinal}>
                        Employee {page.ordinal} · {title(page.stage)} · {duration(page.elapsedMs)}
                        {attempt.outcome !== 'running' && ' at interruption'}
                      </small>
                    ))}
                    {attempt.pageReads.failures.map((page) => (
                      <small key={`${page.ordinal}-${page.attempt}`}>
                        Employee {page.ordinal}, read {page.attempt} · {title(page.stage)} ·{' '}
                        {title(page.error ?? '')} after {duration(page.elapsedMs)}
                        {page.documentState && ` · document ${page.documentState}`}
                        {page.pendingRequests != null &&
                          ` · ${page.pendingRequests} data requests pending`}
                      </small>
                    ))}
                    {attempt.pageReads.slowest.length > 0 && (
                      <p className="muted">
                        Slowest read: employee {attempt.pageReads.slowest[0]!.ordinal} · navigation{' '}
                        {duration(attempt.pageReads.slowest[0]!.navigationMs)}, page content{' '}
                        {duration(attempt.pageReads.slowest[0]!.contentMs)}, extraction{' '}
                        {duration(attempt.pageReads.slowest[0]!.extractionMs)}.
                      </p>
                    )}
                  </div>
                )}
                <p className="muted">
                  Browser memory accounts for shared pages proportionally (PSS). Sampled every
                  second; {attempt.memorySamples} samples, {attempt.incompleteMemorySamples}{' '}
                  incomplete.
                </p>
                {attempt.outcome === 'interrupted' && (
                  <p className="muted">
                    Timings stop at the last saved measurement before interruption.
                  </p>
                )}
              </section>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
