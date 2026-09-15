import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

// The baseline is code only. Never read the installed platform's state or secrets.
const baseline = process.env.DISPATCH_BENCHMARK_BASELINE;
assert(baseline, 'Set DISPATCH_BENCHMARK_BASELINE to the previous Node artifact directory');
const artifact = path.resolve(baseline);
assert(fs.existsSync(path.join(artifact, 'api/main.js')), 'Node baseline artifact required');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-core-benchmark-'));
const employees = 3000,
  days = 30,
  requests = 240;
function rss(pid: number): number {
  try {
    const own =
      Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) *
      1024;
    const children = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return own + children.reduce((sum, child) => sum + rss(Number(child)), 0);
  } catch {
    return 0;
  }
}
function dataset(root: string) {
  const accounts = new DatabaseSync(path.join(root, 'data/platform/accounts.sqlite'));
  const dsp = accounts.prepare("SELECT id FROM dsps WHERE name='Northline Logistics'").get() as {
    id: string;
  };
  accounts.close();
  const db = new DatabaseSync(path.join(root, 'dsps', dsp.id, 'data/dispatch.sqlite'));
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
        'DTX1',
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
    return dsp.id;
  } finally {
    db.close();
  }
}
async function run(runtime: 'node' | 'rust') {
  const root = path.join(temporary, runtime);
  fs.mkdirSync(root, { mode: 0o700 });
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DISPATCH_STANDALONE: '1',
    DISPATCH_ENVIRONMENT: 'preview',
    DISPATCH_STATE_ROOT: root,
    DISPATCH_PROVIDER_MODE: 'fixture',
    DISPATCH_ORIGIN: origin,
    PORT: String(port),
  };
  const executable =
    runtime === 'rust' ? path.resolve('target/release/dispatch-backend') : process.execPath;
  const cwd = runtime === 'rust' ? process.cwd() : artifact;
  execFileSync(
    executable,
    runtime === 'rust' ? ['seed'] : [path.join(artifact, 'tooling/cli.js'), 'seed'],
    { env, cwd, stdio: 'pipe' },
  );
  const id = dataset(root);
  let server: ChildProcess | undefined;
  let peak = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    const start = performance.now();
    server = spawn(
      executable,
      runtime === 'rust' ? ['serve'] : [path.join(artifact, 'api/main.js')],
      { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let logs = '';
    server.stderr!.on('data', (data) => (logs += data));
    server.stdout!.on('data', () => {});
    for (;;) {
      try {
        if ((await fetch(origin + '/api/health')).ok) break;
      } catch {}
      assert(performance.now() - start < 15000 && server.exitCode === null, logs);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const startupMs = performance.now() - start;
    const idleRssBytes = rss(server.pid!);
    peak = idleRssBytes;
    timer = setInterval(() => {
      peak = Math.max(peak, rss(server!.pid!));
    }, 25);
    const headers: Record<string, string> = { origin, 'content-type': 'application/json' };
    async function request(route: string, body?: unknown) {
      return fetch(origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    }
    const login = await request('/api/auth/login', {
      email: 'owner@dispatch.test',
      password: 'Dispatch-demo-2026!',
    });
    assert.equal(login.status, 200);
    headers.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const session = (await (await request('/api/session')).json()) as { csrf: string };
    headers['x-csrf-token'] = session.csrf;
    const view = (await (await request('/api/session/dsp', { dspId: id })).json()) as {
      token: string;
    };
    headers['x-dispatch-view'] = view.token;
    const routes = [
      '/api/dsp/employees?limit=100',
      '/api/dsp/employees?q=Driver%2001&limit=50',
      '/api/dsp/employees/E00050',
      '/api/dsp/timecards?date=2026-08-15&sort=totalHours&direction=desc',
      '/api/session',
    ];
    // Validate the workload before measuring either implementation.
    const list = (await (await request(routes[0]!)).json()) as { total: number };
    assert.equal(list.total, employees);
    const daily = (await (await request(routes[3]!)).json()) as { rows: unknown[] };
    assert.equal(daily.rows.length, employees);
    const expected = await Promise.all(routes.map(async (route) => (await request(route)).json()));
    for (let i = 0; i < 30; i++) await (await request(routes[i % routes.length]!)).arrayBuffer();
    const measurements = [];
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
              start = performance.now();
            const response = await request(routes[index % routes.length]!);
            const payload = await response.text();
            bytes += Buffer.byteLength(payload);
            if (response.ok)
              assert.deepEqual(
                JSON.parse(payload),
                expected[index % routes.length],
                `Response changed for ${runtime} ${routes[index % routes.length]}`,
              );
            if (!response.ok) errors++;
            timings.push(performance.now() - start);
          }
        }),
      );
      const elapsed = performance.now() - began;
      timings.sort((a, b) => a - b);
      measurements.push({
        concurrency,
        requests,
        errors,
        requestsPerSecond: Math.round((requests / elapsed) * 1000),
        medianMs: +timings[Math.floor(timings.length * 0.5)]!.toFixed(2),
        p95Ms: +timings[Math.floor(timings.length * 0.95)]!.toFixed(2),
        responseBytes: bytes,
      });
    }
    return {
      semanticResponses: expected.slice(0, 4),
      binarySha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
      runtime,
      startupMs: Math.round(startupMs),
      idleRssBytes,
      peakRssBytes: peak,
      afterLoadRssBytes: rss(server.pid!),
      measurements,
    };
  } finally {
    clearInterval(timer);
    if (server && server.exitCode === null && server.signalCode === null)
      await new Promise<void>((resolve) => {
        server!.once('exit', () => resolve());
        server!.kill('SIGTERM');
      });
  }
}
try {
  const { semanticResponses: nodeResponses, ...node } = await run('node'),
    { semanticResponses: rustResponses, ...rust } = await run('rust');
  assert.deepEqual(rustResponses, nodeResponses, 'Workforce API responses differ between cores');
  console.log(
    JSON.stringify(
      {
        employees,
        timecards: employees * days,
        baselineCommit: JSON.parse(
          fs.readFileSync(path.join(artifact, 'tooling/build-info.json'), 'utf8'),
        ).commit,
        node,
        rust,
        note: 'Same local TCP HTTP workload, synthetic data, including authentication/view checks and complete response transfer. RSS includes all core descendants. Chromium/provider network excluded; concurrency 16 also exercises admission limits.',
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
