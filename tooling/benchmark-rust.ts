import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixture } from '../tests/helpers.js';
import { fixtureWorkforce } from '../integrations/paycom/fixture.js';

// Disposable synthetic data only; no persistent Dev/Production state is opened.
const f = await fixture({ rustBackendPath: path.resolve('target/release/dispatch-backend') });
try {
  const client = await f.client();
  const dsp = client.session.dsps.find((d) => d.environment === 'production')!;
  const workforce = fixtureWorkforce(dsp);
  f.runtime.runner.workforce.publish(dsp.id, workforce);
  const code = workforce.employees[0]!.code;
  const node = () => f.runtime.runner.workforce.employee(dsp.id, code);
  const rust = () => f.runtime.rust.employee(dsp.id, code);
  assert.deepEqual(await rust(), node());
  const measure = async (read: () => unknown) => {
    for (let i = 0; i < 20; i++) await read();
    const timings: number[] = [];
    for (let i = 0; i < 500; i++) {
      const start = performance.now();
      await read();
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    return { medianMs: timings[250], p95Ms: timings[475] };
  };
  const rss = (pid: number) =>
    Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024;
  const rustIdleRssBytes = rss(f.runtime.rust.pid!);
  const nodeDirect = await measure(node);
  const rustSocketRoundtrip = await measure(rust);
  process.stdout.write(
    JSON.stringify(
      {
        fixture: { employees: workforce.employees.length, timecards: workforce.timecards.length },
        requestsPerImplementation: 500,
        nodeDirect,
        rustSocketRoundtrip,
        rustIdleRssBytes,
        rustAfterReadsRssBytes: rss(f.runtime.rust.pid!),
        nodeHarnessRssBytes: rss(process.pid),
        note: 'Node measures a direct call; Rust includes private HTTP transport. This is a small fixture microbenchmark, not a full-platform load test or memory-savings estimate.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await f.close();
}
