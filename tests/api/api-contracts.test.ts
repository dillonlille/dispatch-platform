import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../support/support.js';
import { parseApiResponse } from '../../shared/contracts/runtime.js';
import type { AuditPage, DspSummary, Job, PlatformHealth } from '../../shared/contracts/index.js';
import type { PaycomSettings } from '../../shared/contracts/paycom.js';

test('recovery-code responses accept the active and previous rollout formats', () => {
  const route = '/api/auth/security/recovery-codes';
  for (const code of ['Ab1_-Cd2.-Ef3_-Gh4.', 'A'.repeat(43)])
    assert.deepEqual(parseApiResponse(route, 'POST', { codes: [code] }), { codes: [code] });
  assert.throws(
    () => parseApiResponse(route, 'POST', { codes: ['A'.repeat(32)] }),
    /invalid_api_response/,
  );
});

test('generated platform contracts validate real responses and settings round trips preserve every preference', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: DspSummary) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const read = async <T>(route: string): Promise<T> => {
    const response = await owner.get(route);
    assert.equal(response.status, 200, response.body);
    const parsed = parseApiResponse(route, 'GET', response.value);
    assert.deepEqual(parsed, response.value);
    return parsed as T;
  };
  const settingsRoute = '/api/dsp/paycom/settings';
  const [settings, health, dsps] = await Promise.all([
    read<PaycomSettings>(settingsRoute),
    read<PlatformHealth>('/api/platform/health'),
    read<DspSummary[]>('/api/platform/dsps'),
  ]);
  const values: PaycomSettings['values'] = {
    ...settings.values,
    opening_page: 'employees',
    rows_per_page: 25,
    name_order: 'last_first',
    default_sort: 'condition',
    department: 'Operations',
    station: 'DEMO1',
    columns: ['condition', 'totalHours'],
    driver_departments: [],
    late_da_time: '09:45',
    late_da_departments: ['Operations'],
  };
  const saved = await owner.post(settingsRoute, { revision: settings.revision, values });
  assert.equal(saved.status, 200);
  const parsed = parseApiResponse(settingsRoute, 'POST', saved.value) as PaycomSettings;
  assert.deepEqual(parsed.values, values);
  assert.deepEqual(parsed.history[0]!.values, settings.values);
  assert.deepEqual((await read<PaycomSettings>(settingsRoute)).values, values);
  // A later UI edit must preserve the preferences its form does not display.
  const changed = await owner.post(settingsRoute, {
    revision: parsed.revision,
    values: { ...parsed.values, late_da_time: '10:30' },
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(
    (parseApiResponse(settingsRoute, 'POST', changed.value) as PaycomSettings).values,
    { ...values, late_da_time: '10:30' },
  );
  const member = await f.client('member@dispatch.test');
  await member.select(dsp.id);
  const memberSettings = await member.get(settingsRoute);
  assert.deepEqual(
    (parseApiResponse(settingsRoute, 'GET', memberSettings.value) as PaycomSettings).history,
    [],
  );
  const audit = await read<AuditPage>('/api/platform/audit');
  assert(
    audit.events.some(
      (event) => event.action === 'paycom.settings_updated' && event.changes.length,
    ),
  );
  const exported = await owner.post('/api/platform/audit/export', {});
  assert.equal(exported.status, 200);
  assert.deepEqual(
    parseApiResponse('/api/platform/audit/export', 'POST', exported.value),
    exported.value,
  );

  const invalid = (route: string, body: unknown) =>
    assert.throws(
      () => parseApiResponse(route, 'GET', body),
      (error: Error) => error.message === 'invalid_api_response',
    );
  const badHealth = structuredClone(health);
  (badHealth.mail as unknown as Record<string, unknown>).pending = 'two';
  invalid('/api/platform/health', badHealth);
  const badProfile = structuredClone(dsps);
  (badProfile[0]!.profile as unknown as Record<string, unknown>).removed = 'false';
  invalid('/api/platform/dsps', badProfile);
  const badAudit = structuredClone(audit);
  (badAudit.events[0]! as unknown as Record<string, unknown>).ref = {
    kind: 'unknown',
    id: 'private-value',
  };
  invalid('/api/platform/audit', badAudit);
  const badSettings = structuredClone(parsed);
  (badSettings.values as unknown as Record<string, unknown>).columns = ['invented-column'];
  invalid(settingsRoute, badSettings);
});

test('job responses use recorded Rust metrics and accept historical records without page diagnostics', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: DspSummary) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/connections/paycom', {
    clientCode: 'contract',
    username: 'fixture-user',
    password: 'fixture-password',
    securityAnswers: ['one', 'two', 'three', 'four', 'five'],
  });
  const queued = await owner.post('/api/dsp/jobs', { requestId: 'contract-metrics' });
  assert.equal(queued.status, 202);
  const id = queued.value.id;
  let jobs: Job[] = [];
  await until(async () => {
    const response = await owner.get('/api/dsp/jobs');
    jobs = parseApiResponse('/api/dsp/jobs', 'GET', response.value) as Job[];
    return jobs.some((job) => job.id === id && job.status === 'succeeded');
  });
  const job = jobs.find((job) => job.id === id)!;
  assert.equal(job.metrics[0]!.outcome, 'succeeded');
  assert(job.metrics[0]!.pageReads);
  f.database('data/preview/jobs.sqlite', (db) =>
    db
      .prepare(
        "UPDATE job_metrics SET metrics=json_remove(metrics,'$.pageReads','$.detail','$.itineraries','$.meals') WHERE job_id=?",
      )
      .run(id),
  );
  const response = await owner.get('/api/dsp/jobs');
  assert.equal(response.status, 200);
  const historical = (parseApiResponse('/api/dsp/jobs', 'GET', response.value) as Job[]).find(
    (row) => row.id === id,
  )!;
  assert.equal(historical.metrics[0]!.pageReads, undefined);
  assert.equal(historical.metrics[0]!.employees, job.metrics[0]!.employees);
  assert.equal(historical.metrics[0]!.collectionMs, job.metrics[0]!.collectionMs);
  const bad = structuredClone(job);
  (bad.metrics[0]! as unknown as Record<string, unknown>).phase = 'private-provider-payload';
  assert.throws(
    () => parseApiResponse('/api/platform/jobs', 'GET', [bad]),
    /^Error: invalid_api_response$/,
  );
});
