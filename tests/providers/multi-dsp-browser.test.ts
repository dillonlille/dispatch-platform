import test from 'node:test';
import assert from 'node:assert/strict';
import { paycomFixture, credentials } from '../support/browseros-paycom-fixture.js';
import { until, seedQueuedJob } from '../support/support.js';
import { processMemory } from '../support/process-memory.js';
import type { Job } from '../../shared/contracts/index.js';

test(
  'multiple DSPs share two browsers fairly while API reads stay responsive',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 300000 },
  async (t) => {
    const count = Number(process.env.DISPATCH_CAPACITY_EMPLOYEES ?? 21);
    assert(Number.isInteger(count) && count >= 3 && count <= 500);
    const f = await paycomFixture();
    t.after(f.close);
    f.state.timecardDelayMs = 350;
    const accounts = ['fixture-a', 'fixture-b', 'fixture-c'];
    for (const [index, account] of accounts.entries()) {
      f.state.accounts[account] = Array.from(
        { length: count },
        (_, n) => `${String.fromCharCode(65 + index)}${String(n).padStart(3, '0')}`,
      );
    }
    const admin = await f.client();
    const dsps = ['Northline Logistics', 'Summit Delivery', 'Dev DSP'].map((name) =>
      admin.session.dsps.find((d: { name: string }) => d.name === name),
    );
    // Authenticate and close each session, so the queued jobs exercise profile
    // reuse without filling capacity with settings-page sessions.
    for (const [i, dsp] of dsps.entries()) {
      const client = await f.client();
      await client.select(dsp.id);
      assert.equal(
        (
          await client.post('/api/dsp/connections/paycom', {
            ...credentials,
            username: accounts[i],
          })
        ).value.status,
        'ready',
      );
      await f.stop();
      await f.start();
    }
    const clients: Awaited<ReturnType<typeof f.client>>[] = [];
    for (const dsp of dsps) {
      const client = await f.client();
      await client.select(dsp.id);
      clients.push(client);
    }
    const owner = await f.client();
    const jobs: string[] = [];
    // Hold the first DSP's requests until another DSP reaches the provider.
    // This proves independent collection without requiring short responses to
    // happen to overlap. Under memory pressure the bounded gate lets one browser
    // continue, without exceeding the driver's navigation deadline.
    let releaseFirst!: () => void;
    const firstRequests = new Promise<void>((resolve) => (releaseFirst = resolve));
    const gateAccounts = new Set<string>();
    const gateTimer = setTimeout(releaseFirst, 20000);
    // Also rendezvous each DSP's first two tabs. A fixed response delay cannot
    // prove concurrency when the browser starts those navigations unevenly.
    const pairs = new Map<
      string,
      { arrivals: number; ready: Promise<void>; release: () => void; timer: NodeJS.Timeout }
    >();
    t.after(() => {
      clearTimeout(gateTimer);
      releaseFirst();
      for (const pair of pairs.values()) {
        clearTimeout(pair.timer);
        pair.release();
      }
    });
    f.state.beforeTimecard = async (account) => {
      let pair = pairs.get(account);
      if (!pair) {
        let release!: () => void;
        const ready = new Promise<void>((resolve) => (release = resolve));
        pair = { arrivals: 0, ready, release, timer: setTimeout(release, 10000) };
        pairs.set(account, pair);
      }
      if (++pair.arrivals === 2) {
        clearTimeout(pair.timer);
        pair.release();
      }
      gateAccounts.add(account);
      if (gateAccounts.size > 1) {
        clearTimeout(gateTimer);
        releaseFirst();
      }
      await Promise.all([firstRequests, pair.ready]);
    };
    // A retained queued job from A must not jump ahead of C's first collection.
    for (const index of [0, 0, 1, 2]) {
      if (jobs.length === 1) {
        const blocked = await clients[index]!.post('/api/dsp/jobs', { requestId: 'extra-manual' });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.value.error, 'sync_in_progress');
        jobs.push(seedQueuedJob(f, jobs[0]!, 'retained-queued').id);
        continue;
      }
      const response = await clients[index]!.post('/api/dsp/jobs', {
        requestId: `capacity-${jobs.length}`,
      });
      assert.equal(response.status, 202, response.body);
      jobs.push(response.value.id);
    }
    const latencies: number[] = [];
    let peakBrowsers = 0,
      peakRssBytes = 0,
      peakPssBytes = 0,
      peakPrivateBytes = 0;
    let completeMemorySamples = 0,
      maxRunningPerDsp = 0;
    let memoryDelayed = false;
    const began = performance.now();
    let final: Job[] = [];
    await until(async () => {
      const start = performance.now();
      const [health, listed, employees, session] = await Promise.all([
        owner.get('/api/platform/health'),
        owner.get('/api/platform/jobs'),
        clients[0]!.get('/api/dsp/employees'),
        owner.get('/api/session'),
      ]);
      latencies.push(performance.now() - start);
      for (const response of [health, listed, employees, session])
        assert.equal(response.status, 200, response.body);
      memoryDelayed ||= !health.value.browsers.memory.canStart;
      peakBrowsers = Math.max(peakBrowsers, health.value.browsers.active);
      assert(health.value.browsers.active <= 2);
      const ours = (listed.value as Job[]).filter((j) => jobs.includes(j.id));
      for (const dsp of dsps) {
        const running = ours.filter(
          (j) => j.dspId === dsp.id && ['running', 'waiting_verification'].includes(j.status),
        ).length;
        maxRunningPerDsp = Math.max(maxRunningPerDsp, running);
        assert(running <= 1);
      }
      for (const job of ours)
        assert(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job));
      const memory = await processMemory(f.pid());
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      if (!memory.incomplete) {
        completeMemorySamples++;
        peakPssBytes = Math.max(peakPssBytes, memory.pss);
        peakPrivateBytes = Math.max(peakPrivateBytes, memory.privateBytes);
      }
      final = ours;
      if (ours.length === 4 && ours.every((job) => job.status === 'succeeded')) return true;
      await new Promise((resolve) => setTimeout(resolve, 950));
      return false;
    }, 240000);
    assert(
      peakBrowsers === 2 || (peakBrowsers === 1 && memoryDelayed),
      'Use two browsers when memory permits; queue under pressure',
    );
    assert.equal(maxRunningPerDsp, 1);
    assert(f.state.timecardsPeak >= 2 && f.state.timecardsPeak <= 4);
    if (peakBrowsers === 2 && !memoryDelayed)
      assert.equal(f.state.timecardAccountsPeak, 2, 'Distinct DSPs must collect concurrently');
    for (const account of accounts)
      assert.equal(
        f.state.peakByAccount.get(account),
        2,
        `${account} must use two concurrent tabs`,
      );
    assert.equal(f.state.accountStarts.filter((v) => v === accounts[0]).length, 2);
    // Fairness is the order in which jobs receive a slot. If both slots free
    // together, different browser startup times can reorder the first HTTP request.
    assert(
      Date.parse(final.find((j) => j.id === jobs[3])!.startedAt!) <=
        Date.parse(final.find((j) => j.id === jobs[1])!.startedAt!),
      'C must receive a slot before A collects again',
    );
    assert.equal(
      f.events.filter((event) => event === 'primary').length,
      3,
      'Collection reuses each DSP profile',
    );
    for (const [i, client] of clients.entries()) {
      assert.equal((await client.get('/api/dsp/employees')).value.total, count);
      const actual = f.collector(dsps[i].id, (db) =>
        db
          .prepare(
            'SELECT employee_code code,count(*) days FROM timecards WHERE publication_id=(SELECT id FROM publications WHERE active=1) GROUP BY employee_code ORDER BY employee_code',
          )
          .all(),
      );
      assert.deepEqual(
        actual.map((row) => ({ ...row })),
        f.state.accounts[accounts[i]!]!.map((code) => ({ code, days: 14 })),
      );
    }
    for (const job of final) {
      assert.equal(job.metrics.length, 1);
      assert(job.metrics[0]!.peakPssBytes! > 0);
      assert.equal(job.metrics[0]!.employees, count);
      assert.equal(job.metrics[0]!.timecards, count * 14);
    }
    assert(
      final.find((j) => j.id === jobs[1])!.metrics[0]!.queueMs >
        final.find((j) => j.id === jobs[0])!.metrics[0]!.queueMs,
    );
    await until(async () => (await owner.get('/api/platform/health')).value.browsers.active === 0);
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
    assert(
      p95 < 2000,
      `API read batch p95 ${p95.toFixed(0)} ms exceeded the responsiveness budget`,
    );
    console.log(
      'CAPACITY',
      JSON.stringify({
        employeesPerDsp: count,
        dsps: 3,
        collections: 4,
        collectedDailyRecords: count * 14 * 4,
        elapsedMs: Math.round(performance.now() - began),
        peakBrowsers,
        memoryDelayed,
        peakTimecardRequests: f.state.timecardsPeak,
        peakCollectingDsps: f.state.timecardAccountsPeak,
        readBatches: latencies.length,
        readBatchP95Ms: Math.round(p95),
        peakRssBytes,
        peakPssBytes,
        peakPrivateBytes,
        completeMemorySamples,
        queueMs: jobs.map((id) => final.find((j) => j.id === id)!.metrics[0]!.queueMs),
      }),
    );
  },
);
