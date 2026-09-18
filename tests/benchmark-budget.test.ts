import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBenchmark, budgets, type BenchmarkReport } from '../tooling/benchmark-budget.js';
const sample = (): BenchmarkReport => ({
  startupMs: 50,
  idleRssBytes: 12 * 1024 ** 2,
  peakRssBytes: 80 * 1024 ** 2,
  afterLoadRssBytes: 20 * 1024 ** 2,
  completedCollections: 4,
  observedRunning: 8,
  measurements: (['single-dsp', 'multi-dsp-collection'] as const).flatMap((scenario) =>
    [1, 4, 8, 16].map((concurrency) => ({
      scenario,
      concurrency,
      requests: 240,
      errors: 0,
      requestsPerSecond: 100,
      medianMs: 20,
      p95Ms: 50,
      responseBytes: 100000,
    })),
  ),
});
test('benchmark failures cannot pass as successful measurements', () => {
  checkBenchmark(sample(), true);
  for (const corrupt of [
    (r: BenchmarkReport) => {
      r.measurements[0]!.errors = 1;
    },
    (r: BenchmarkReport) => {
      r.measurements.pop();
    },
    (r: BenchmarkReport) => {
      r.measurements[0]!.requests = 1;
    },
    (r: BenchmarkReport) => {
      r.measurements[0]!.p95Ms = NaN;
    },
    (r: BenchmarkReport) => {
      r.completedCollections = 0;
    },
    (r: BenchmarkReport) => {
      r.observedRunning = 0;
    },
  ]) {
    const report = sample();
    corrupt(report);
    assert.throws(() => checkBenchmark(report));
  }
  for (const corrupt of [
    (r: BenchmarkReport) => {
      r.measurements[0]!.p95Ms = budgets.p95Ms + 1;
    },
    (r: BenchmarkReport) => {
      r.measurements[0]!.requestsPerSecond = budgets.requestsPerSecond - 1;
    },
    (r: BenchmarkReport) => {
      r.peakRssBytes = budgets.peakRssBytes + 1;
    },
  ]) {
    const report = sample();
    corrupt(report);
    checkBenchmark(report);
    assert.throws(() => checkBenchmark(report, true));
  }
});
test('an HTTP error names the failed route, status and response', () => {
  const report = sample();
  report.measurements[0]!.errors = 1;
  report.failures = [
    {
      scenario: report.measurements[0]!.scenario,
      concurrency: report.measurements[0]!.concurrency,
      route: '/api/session',
      tenant: 0,
      status: 503,
      body: '{"error":"busy"}',
    },
  ];
  assert.throws(() => checkBenchmark(report), /\/api\/session returned 503: \{"error":"busy"\}/);
});
