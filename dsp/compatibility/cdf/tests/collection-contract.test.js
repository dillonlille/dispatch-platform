'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  DAY_MS, periodFromWeek, resolveTargets, validateCompletedWeek, weekForSourceDate,
} = require('../src/periods');
const {
  MAX_ROWS, canonicalStringify, parseCsv, sha256, validateCsv, validateProviderJson,
} = require('../src/validation');
const { validateManifest } = require('../src/artifacts');
const { safeFailure, validateRequest } = require('../src/collector');

const fixtures = path.join(__dirname, "./fixtures");

test('CDF reporting weeks use Sunday through Saturday and resolve exact targets', () => {
  assert.deepEqual(periodFromWeek('2026-W20'), { key: '2026-W20', start: '2026-05-10', end: '2026-05-16' });
  assert.equal(weekForSourceDate('2026-05-12'), '2026-W20');
  assert.deepEqual(resolveTargets({ selectorKind: 'latest-complete', date: '2026-08-26' }).targets, [
    { key: '2026-W34', start: '2026-08-16', end: '2026-08-22', values: { week: '2026-W34' } },
  ]);
  assert.equal(validateCompletedWeek('2026-W20', '2026-08-29').key, '2026-W20');
  assert.throws(() => validateCompletedWeek('2026-W35', '2026-08-29'), error => error.code === 'week_not_completed');
  assert.doesNotThrow(() => validateRequest({
    protocolVersion: 1, runId: 'run_poll_attempt_96', plan: 'cdf-week-collect',
    source: {
      id: 'cdf-example', collector: 'cdf', authProfile: 'amazon-example',
      config: { timezone: 'America/Los_Angeles', station: 'TST1', companyId: 'fixture-company', dsp: 'fixture-dsp' },
    },
    method: 'cdf.week.collect', input: { week: '2026-W20', replace: false }, attempt: 96,
    deadline: '2099-08-29T12:00:00.000Z',
  }));
  assert.deepEqual(resolveTargets({ selectorKind: 'date', date: '2026-05-12' }).targets, [
    { key: '2026-W20', start: '2026-05-10', end: '2026-05-16', values: { week: '2026-W20' } },
  ]);
  assert.deepEqual(resolveTargets({ selectorKind: 'date-range', start: '2026-05-16', end: '2026-05-17' }).targets.map(item => item.key), [
    '2026-W20', '2026-W21',
  ]);
  assert.deepEqual(resolveTargets({
    selectorKind: 'target-range', startKey: '2026-W20', endKey: '2026-W22', date: '2026-08-29',
  }).targets.map(item => item.key), ['2026-W20', '2026-W21', '2026-W22']);
  assert.deepEqual(resolveTargets({
    selectorKind: 'target-range', startKey: '2025-W52', endKey: '2026-W02', date: '2026-08-29',
  }).targets.map(item => item.key), ['2025-W52', '2026-W01', '2026-W02']);
  assert.throws(() => resolveTargets({
    selectorKind: 'target-range', startKey: '2026-W22', endKey: '2026-W20', date: '2026-08-29',
  }), error => error.code === 'invalid_period');
  assert.throws(() => resolveTargets({
    selectorKind: 'target-range', startKey: '2026-W34', endKey: '2026-W35', date: '2026-08-29',
  }), error => error.code === 'week_not_completed');
  let oversized;
  try {
    resolveTargets({
      selectorKind: 'target-range', startKey: '2025-W01', endKey: '2026-W20', date: '2026-08-29',
    });
  } catch (error) { oversized = error; }
  assert.equal(oversized?.code, 'target_range_too_large');
  assert.equal(safeFailure(oversized).error.code, 'target_range_too_large');
  const rangeStart = new Date('2026-01-01T00:00:00.000Z');
  const allowedEnd = new Date(rangeStart.valueOf() + 729 * DAY_MS).toISOString().slice(0, 10);
  const rejectedEnd = new Date(rangeStart.valueOf() + 730 * DAY_MS).toISOString().slice(0, 10);
  assert.doesNotThrow(() => resolveTargets({ selectorKind: 'date-range', start: '2026-01-01', end: allowedEnd }));
  assert.throws(() => resolveTargets({ selectorKind: 'date-range', start: '2026-01-01', end: rejectedEnd }),
    error => error.code === 'invalid_period');
});

test('CDF CSV and provider artifacts are exact-week, strict, and bounded', () => {
  const csv = fs.readFileSync(path.join(fixtures, '2026-W20.csv'));
  const providers = fs.readFileSync(path.join(fixtures, '2026-W20-providers.json'));
  const source = validateCsv(csv, '2026-W20');
  const links = validateProviderJson(providers, '2026-W20');
  assert.equal(source.schema, 'cdf-negative-v1');
  assert.equal(source.rowCount, 1);
  assert.equal(source.columnCount, 12);
  assert.equal(links.rowCount, 1);
  const headerOnly = Buffer.from(`${csv.toString().split('\n')[0]}\n`);
  assert.equal(validateCsv(headerOnly, '2026-W20').rowCount, 0);
  assert.throws(() => validateCsv(Buffer.from(csv.toString().replace(',1,0,0,1,0,0,', ',yes,0,0,1,0,0,')), '2026-W20'),
    error => error.code === 'csv_category_invalid');
  assert.throws(() => validateCsv(Buffer.from(csv.toString().replace('10:11:12', '99:99:99')), '2026-W20'),
    error => error.code === 'csv_delivery_date_invalid');
  assert.throws(() => validateCsv(csv, '2026-W21'), error => error.code === 'csv_wrong_week');
  assert.throws(() => validateCsv(Buffer.from('<html>login</html>'), '2026-W20'), error => error.code === 'csv_is_html');
  assert.throws(() => parseCsv(['header', ...Array(MAX_ROWS + 1).fill('row')].join('\n')),
    error => error.code === 'csv_too_many_rows');

  const manifestBase = {
    contractVersion: 1,
    week: '2026-W20',
    station: 'TST1',
    companyId: 'fixture-company',
    dsp: 'fixture-dsp',
    collectedAt: '2026-08-29T12:00:00.000Z',
    runId: 'run_manifest',
    attempt: 1,
    source: { name: 'cdf-negative.csv', ...source },
    providerLinks: { name: 'provider-links.json', status: 'degraded', ...links },
  };
  const identity = {
    contractVersion: manifestBase.contractVersion,
    week: manifestBase.week,
    station: manifestBase.station,
    companyId: manifestBase.companyId,
    dsp: manifestBase.dsp,
    source: manifestBase.source,
    providerLinks: manifestBase.providerLinks,
  };
  const unsigned = { ...manifestBase, collectionDigest: sha256(Buffer.from(canonicalStringify(identity))) };
  const malformed = { ...unsigned, manifestSha256: sha256(Buffer.from(canonicalStringify(unsigned))) };
  assert.throws(() => validateManifest(malformed), error => error.code === 'manifest_invalid');
});
