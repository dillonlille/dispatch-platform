import { collectorDatabase } from './collector-storage.js';
import { checkBenchmark, type Failure, type Measurement } from './benchmark-budget.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { parseArgs } from 'node:util';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { jobSchema, sessionSchema } from '../shared/contracts/runtime.js';

const { values } = parseArgs({
  options: {
    binary: { type: 'string', default: 'target/release/dispatch-backend' },
    output: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-core-benchmark-'));
const employees = 3000,
  days = 30,
  requests = 240;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function rss(pid: number): number {
  // Synthetic collectors stay inside the core. Native browser memory is checked
  // separately by the native capacity suite.
  return (
    Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) *
    1024
  );
}
function dataset(root: string) {
  const accounts = new DatabaseSync(path.join(root, 'data/platform/accounts.sqlite'));
  const tenants = accounts.prepare('SELECT id,name FROM dsps ORDER BY name').all() as {
    id: string;
    name: string;
  }[];
  accounts.close();
  const readers = tenants.filter((d) => d.name !== 'Summit Delivery');
  for (const [index, dsp] of readers.entries()) {
    const db = new DatabaseSync(collectorDatabase(root, dsp.id, 'paycom'));
    try {
      db.exec('BEGIN; DELETE FROM timecards; DELETE FROM employees; DELETE FROM publications;');
      const publication = 'pub_' + '0'.repeat(32);
      db.prepare(
        'INSERT INTO publications(id,collected_at,period_from,period_to,active) VALUES (?,?,?,?,1)',
      ).run(publication, '2026-09-01T00:00:00.000Z', '2026-08-01', '2026-08-30');
      const employee = db.prepare('INSERT INTO employees VALUES (?,?,?,?,?,?,?)');
      const card = db.prepare('INSERT INTO timecards VALUES (?,?,?,?,?,?)');
      for (let i = 0; i < employees; i++) {
        const code = `E${String(i).padStart(5, '0')}`;
        employee.run(
          publication,
          code,
          `Driver ${String(employees - i).padStart(5, '0')}`,
          'Delivery',
          'Driver',
          `DSP${index}`,
          1,
        );
        for (let day = 1; day <= days; day++)
          card.run(
            publication,
            code,
            `2026-08-${String(day).padStart(2, '0')}`,
            8,
            'Complete',
            '[{"in":"08:00","out":"16:00","hours":8}]',
          );
      }
      db.exec(
        'UPDATE schedules SET enabled=0,next_run=NULL; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)',
      );
    } finally {
      db.close();
    }
  }
  return { readers, writer: tenants.find((d) => d.name === 'Summit Delivery')! };
}
async function run() {
  const root = path.join(temporary, 'rust');
  fs.mkdirSync(root, { mode: 0o700 });
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const executable = path.resolve(values.binary!);
  const artifact = path.resolve(path.dirname(executable), '../..');
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DISPATCH_STANDALONE: '1',
    DISPATCH_ENVIRONMENT: 'preview',
    DISPATCH_STATE_ROOT: root,
    DISPATCH_PROVIDER_MODE: 'fixture',
    DISPATCH_TRUSTED_PROXY: 'none',
    DISPATCH_DEV_MAIL_MODE: 'disabled',
    DISPATCH_ARTIFACT_ROOT: fs.existsSync(path.join(artifact, 'release.json'))
      ? artifact
      : process.cwd(),
    DISPATCH_ORIGIN: origin,
    PORT: String(port),
  };
  execFileSync(executable, ['seed'], { env, stdio: 'pipe' });
  const tenants = dataset(root);
  let server: ChildProcess | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let peak = 0,
    logs = '';
  const started = performance.now();
  try {
    server = spawn(executable, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr!.on('data', (data) => {
      logs = (logs + data).slice(-16000);
    });
    server.stdout!.on('data', () => {});
    for (;;) {
      try {
        if ((await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) })).ok) break;
      } catch {}
      assert(performance.now() - started < 15000 && server.exitCode === null, logs);
      await pause(20);
    }
    const startupMs = performance.now() - started,
      idleRssBytes = rss(server.pid!);
    peak = idleRssBytes;
    timer = setInterval(() => {
      if (server?.exitCode === null) {
        try {
          peak = Math.max(peak, rss(server.pid!));
        } catch {}
      }
    }, 25);
    const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
    const request = (route: string, body?: unknown, client = headers) =>
      fetch(origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: client,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    async function json(route: string, body?: unknown, client = headers): Promise<any> {
      const response = await request(route, body, client);
      assert(response.ok, `${route} returned ${response.status}`);
      return response.json();
    }
    const login = await request('/api/auth/login', {
      email: 'owner@dispatch.test',
      password: 'Dispatch-demo-2026!',
    });
    assert.equal(login.status, 200);
    headers.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const session = sessionSchema.parse(await json('/api/session'));
    headers['x-csrf-token'] = session.csrf;
    async function client(id: string) {
      const view = await json('/api/session/dsp', { dspId: id });
      return { ...headers, 'x-dispatch-view': view.token as string };
    }
    const clients = await Promise.all(tenants.readers.map((d) => client(d.id)));
    const writer = await client(tenants.writer.id);
    await json(
      '/api/dsp/connections/paycom',
      {
        clientCode: 'benchmark',
        username: 'fixture-user',
        password: 'fixture-password',
        securityAnswers: ['one', 'two', 'three', 'four', 'five'],
      },
      writer,
    );
    const routes = [
      '/api/dsp/employees?limit=100',
      '/api/dsp/employees?q=Driver%2001&limit=50',
      '/api/dsp/employees/E00050',
      '/api/dsp/timecards?date=2026-08-15&sort=totalHours&direction=desc',
      '/api/session',
    ];
    const stable = (route: string, value: any) => {
      if (route !== '/api/session') return value;
      const { dsps: _dsps, ...auth } = sessionSchema.parse(value);
      return auth; // DSP lastCollection changes while the writer publishes.
    };
    const expected = await Promise.all(
      clients.map(async (c) => {
        assert.equal((await json(routes[0]!, undefined, c)).total, employees);
        assert.equal((await json(routes[3]!, undefined, c)).rows.length, employees);
        return Promise.all(
          routes.map(async (route) => stable(route, await json(route, undefined, c))),
        );
      }),
    );
    assert.notDeepEqual(
      expected[0]![0],
      expected[1]![0],
      'Reader DSPs must contain distinct station data',
    );
    for (let i = 0; i < 30; i++)
      await json(routes[i % routes.length]!, undefined, clients[i % clients.length]);
    const measurements: Measurement[] = [];
    // A failed response is reported in full: the count alone cannot explain a CI failure.
    const failures: Failure[] = [];
    let completedCollections = 0,
      observedRunning = 0;
    for (const scenario of ['single-dsp', 'multi-dsp-collection'] as const) {
      let measuring = true,
        backgroundError: unknown;
      const background =
        scenario === 'single-dsp'
          ? Promise.resolve()
          : (async () => {
              let sequence = 0;
              while (measuring) {
                const job = jobSchema.parse(
                  await json('/api/dsp/jobs', { requestId: `benchmark-${sequence++}` }, writer),
                );
                const deadline = performance.now() + 15000;
                for (;;) {
                  const rows = (await json('/api/dsp/jobs', undefined, writer)) as unknown[];
                  const current = rows
                    .map((row) => jobSchema.parse(row))
                    .find((row) => row.id === job.id)!;
                  assert(
                    !['failed', 'cancelled'].includes(current.status),
                    `Background collection ${current.status}`,
                  );
                  if (current.status === 'running' && measuring) observedRunning++;
                  if (current.status === 'succeeded') {
                    if (measuring) completedCollections++;
                    break;
                  }
                  assert(performance.now() < deadline, 'Background collection stalled');
                  await pause(25);
                }
              }
            })().catch((error) => {
              backgroundError = error;
            });
      try {
        for (const concurrency of [1, 4, 8, 16]) {
          const timings: number[] = [];
          let next = 0,
            errors = 0,
            bytes = 0;
          const began = performance.now();
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              while (next < requests) {
                const index = next++,
                  route = routes[index % routes.length]!,
                  tenant = scenario === 'single-dsp' ? 0 : index % clients.length;
                const start = performance.now();
                const response = await request(route, undefined, clients[tenant]);
                const payload = await response.text();
                bytes += Buffer.byteLength(payload);
                if (response.ok)
                  assert.deepEqual(
                    stable(route, JSON.parse(payload)),
                    expected[tenant]![index % routes.length],
                    `${scenario}: response changed for ${route}`,
                  );
                else {
                  errors++;
                  failures.push({
                    scenario,
                    concurrency,
                    route,
                    tenant,
                    status: response.status,
                    body: payload.slice(0, 300),
                  });
                }
                timings.push(performance.now() - start);
              }
            }),
          );
          const elapsed = performance.now() - began;
          timings.sort((a, b) => a - b);
          measurements.push({
            scenario,
            concurrency,
            requests,
            errors,
            requestsPerSecond: Math.round((requests / elapsed) * 1000),
            medianMs: +timings[Math.floor(timings.length * 0.5)]!.toFixed(2),
            p95Ms: +timings[Math.floor(timings.length * 0.95)]!.toFixed(2),
            responseBytes: bytes,
          });
        }
      } finally {
        measuring = false;
        await background;
      }
      if (backgroundError) throw backgroundError;
    }
    return {
      format: 1,
      employeesPerDsp: employees,
      timecardsPerDsp: employees * days,
      binarySha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
      machine: {
        platform: os.platform(),
        architecture: os.arch(),
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
      },
      startupMs: Math.round(startupMs),
      idleRssBytes,
      peakRssBytes: peak,
      afterLoadRssBytes: rss(server.pid!),
      failures,
      completedCollections,
      observedRunning,
      measurements,
      note: 'Synthetic TCP workload with full responses, two reader DSPs and one collecting DSP. Chromium and provider networking are covered separately by native capacity tests.',
    };
  } finally {
    clearInterval(timer);
    if (server && server.exitCode === null && server.signalCode === null)
      await new Promise<void>((resolve, reject) => {
        const child = server!;
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Benchmark core failed to stop'));
        }, 10000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill('SIGTERM');
      });
  }
}
try {
  const report = await run();
  const output = JSON.stringify(report, null, 2) + '\n';
  if (values.output) fs.writeFileSync(values.output, output);
  process.stdout.write(output);
  // Correctness is mandatory in every mode; --check also enforces broad CI budgets.
  checkBenchmark(report, values.check);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
