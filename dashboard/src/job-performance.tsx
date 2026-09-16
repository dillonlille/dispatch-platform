import { useState } from 'react';
import type { JobMetrics } from '../../shared/contracts/index.js';
import { title } from './ui.js';

function duration(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
function memory(bytes: number | null) {
  return bytes === null ? 'Not sampled' : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
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
                {attempt.error && <small>{title(attempt.error)}</small>}
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
