import type { Job } from '../../../../../shared/contracts/index.js';

const finished = ['succeeded', 'failed', 'cancelled'];
/** Queued, running or waiting for verification. */
export const isUnderway = (status: Job['status']) => !finished.includes(status);
export const providerName = (kind: Job['kind']) =>
  kind === 'paycom.collect' ? 'Paycom' : 'Cortex';
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function runHistory(job: Job) {
  const metrics = job.metrics ?? [],
    latest = metrics.at(-1);
  const collections = metrics.flatMap((m) => (m.collectionMs === null ? [] : [m.collectionMs]));
  const peaks = metrics.flatMap((m) => (m.peakPssBytes === null ? [] : [m.peakPssBytes]));
  const resumed = metrics.reduce((n, m) => n + (m.pageReads?.resumed ?? 0), 0);
  const count = job.kind === 'paycom.collect' ? latest?.employees : latest?.itineraries;
  const collectionMs = collections.length ? collections.reduce((a, b) => a + b, 0) : null;
  // Interrupted measurements end at the last saved sample. Compare only complete
  // first attempts with a known workload, and normalize collection time by count.
  const comparable =
    job.status === 'succeeded' &&
    job.attempt === 1 &&
    metrics.length === 1 &&
    latest?.outcome === 'succeeded' &&
    resumed === 0 &&
    count != null &&
    count > 0;
  return {
    job,
    collectionMs,
    peakBytes: peaks.length ? Math.max(...peaks) : null,
    resumed,
    pageRetries: metrics.reduce((n, m) => n + (m.pageReads?.retries ?? 0), 0),
    jobRetries: Math.max(0, job.attempt - 1),
    perItemMs: comparable && collectionMs !== null ? collectionMs / count! : null,
    comparable,
    partial: metrics.some((m) => m.outcome === 'interrupted'),
  };
}
export function collectionHistory(jobs: Job[]) {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const key = `${job.dspId}:${job.kind}`;
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  return [...groups]
    .map(([key, jobs]) => {
      const sorted = jobs.toSorted(
        (a, b) =>
          Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt),
      );
      const runs = sorted.filter((j) => !isUnderway(j.status)).map(runHistory);
      const underway = sorted.filter((j) => isUnderway(j.status)).map(runHistory);
      const successes = runs.filter((r) => r.job.status === 'succeeded');
      const latest = successes[0];
      const baseline = successes
        .slice(1)
        .filter((r) => r.comparable)
        .slice(0, 5);
      const warnings: string[] = [];
      const speeds = baseline.flatMap((r) => (r.perItemMs === null ? [] : [r.perItemMs]));
      const speed = median(speeds);
      if (
        latest?.perItemMs != null &&
        speeds.length === 5 &&
        speed !== null &&
        speed > 0 &&
        latest.perItemMs > speed * 1.25
      )
        warnings.push(
          `Latest full run took ${Math.round((latest.perItemMs / speed - 1) * 100)}% longer per ${latest.job.kind === 'paycom.collect' ? 'employee' : 'itinerary'} than the median of the previous five full runs.`,
        );
      const memory = baseline.flatMap((r) => (r.peakBytes === null ? [] : [r.peakBytes]));
      const peak = median(memory);
      if (
        latest?.comparable &&
        latest.peakBytes !== null &&
        memory.length === 5 &&
        peak !== null &&
        peak > 0 &&
        latest.peakBytes > Math.max(peak * 1.25, peak + 32 * 1024 ** 2)
      )
        warnings.push(
          `Latest full run used ${Math.round((latest.peakBytes / peak - 1) * 100)}% more peak browser memory than the previous five full runs.`,
        );
      const failed = runs.filter(
        (r) =>
          r.job.status === 'failed' &&
          (!latest || Date.parse(r.job.completedAt!) > Date.parse(latest.job.completedAt!)),
      ).length;
      if (failed)
        warnings.push(
          `${failed} failed collection${failed === 1 ? '' : 's'}${latest ? ' since the last success' : '; no success recorded'} in this history.`,
        );
      const durations = successes
        .filter((r) => r.comparable && r.collectionMs !== null)
        .slice(0, 20)
        .map((r) => r.collectionMs!)
        .sort((a, b) => a - b);
      return {
        key,
        label: `${jobs[0]!.dspName} · ${providerName(jobs[0]!.kind)}`,
        /** The newest job, finished or not. */
        newest: sorted[0]!,
        /** Queued, running or waiting for verification: no part of the statistics. */
        underway,
        runs,
        latest,
        warnings,
        samples: durations.length,
        medianMs: median(durations),
        p95Ms: durations.length >= 5 ? durations[Math.ceil(durations.length * 0.95) - 1]! : null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export type CollectionSource = ReturnType<typeof collectionHistory>[number];
export type CollectionRun = CollectionSource['runs'][number];
