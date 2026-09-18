import assert from 'node:assert/strict';

export interface Measurement {
  scenario: 'single-dsp' | 'multi-dsp-collection';
  concurrency: number;
  requests: number;
  errors: number;
  requestsPerSecond: number;
  medianMs: number;
  p95Ms: number;
  responseBytes: number;
}
export interface BenchmarkReport {
  startupMs: number;
  idleRssBytes: number;
  peakRssBytes: number;
  afterLoadRssBytes: number;
  completedCollections: number;
  observedRunning: number;
  measurements: Measurement[];
}
// Deliberately broad across host/CI hardware. Keep tighter comparisons in the
// recorded baseline; never auto-adjust these budgets to accept a failed run.
export const budgets = {
  startupMs: 5000,
  idleRssBytes: 64 * 1024 ** 2,
  peakRssBytes: 256 * 1024 ** 2,
  p95Ms: 2000,
  requestsPerSecond: 10,
};
export function checkBenchmark(report: BenchmarkReport, performance = false) {
  assert.equal(report.measurements.length, 8, 'Incomplete benchmark coverage');
  for (const scenario of ['single-dsp', 'multi-dsp-collection'])
    for (const concurrency of [1, 4, 8, 16]) {
      const rows = report.measurements.filter(
        (row) => row.scenario === scenario && row.concurrency === concurrency,
      );
      assert.equal(rows.length, 1, `Missing/duplicate workload: ${scenario}/${concurrency}`);
      const row = rows[0]!;
      assert.equal(row.requests, 240, 'Incomplete request workload');
      assert.equal(row.errors, 0, `${scenario}/${concurrency}: HTTP errors`);
      for (const value of [row.requestsPerSecond, row.p95Ms, row.medianMs, row.responseBytes])
        assert(Number.isFinite(value) && value > 0, 'Invalid workload measurement');
      if (performance) {
        assert(
          row.p95Ms <= budgets.p95Ms,
          `${scenario}/${concurrency}: p95 ${row.p95Ms} exceeds ${budgets.p95Ms}ms`,
        );
        assert(
          row.requestsPerSecond >= budgets.requestsPerSecond,
          `${scenario}/${concurrency}: throughput below budget`,
        );
      }
    }
  assert(report.completedCollections > 0, 'No collections completed during the read workload');
  assert(report.observedRunning > 0, 'No running collection overlapped the read workload');
  for (const key of ['startupMs', 'idleRssBytes', 'peakRssBytes', 'afterLoadRssBytes'] as const)
    assert(Number.isFinite(report[key]) && report[key] > 0, `Invalid ${key}`);
  if (performance)
    for (const key of ['startupMs', 'idleRssBytes', 'peakRssBytes'] as const)
      assert(report[key] <= budgets[key], `${key} exceeds budget`);
}
