'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultPaths } = require('dispatch-runtime-kit/collection-manager/src/paths');

const FIXTURE_COLLECTOR = path.resolve(__dirname, "./fixture-collector.js");
const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {}, required: [], additionalProperties: false });
const LABEL_SCHEMA = Object.freeze({
  type: 'object',
  properties: { label: { type: 'string', maxLength: 64 } },
  required: [],
  additionalProperties: false,
});

const SYNC_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    behavior: { type: 'string', enum: ['no_change', 'published', 'sleep'] },
    label: { type: 'string', maxLength: 64 },
  },
  required: ['behavior'],
  additionalProperties: false,
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-collection-store-'));
  fs.chmodSync(root, 0o700);
  return { root, paths: defaultPaths({ databaseRoot: path.join(root, 'db'), stateRoot: path.join(root, 'state') }) };
}

function spec() {
  return {
    schemaVersion: 1,
    collectors: [{
      id: 'fixture', version: '1.0.0', description: 'Test collector', command: FIXTURE_COLLECTOR,
      sourceSchema: {
        type: 'object', properties: { tenant: { type: 'string', maxLength: 64 } },
        required: ['tenant'], additionalProperties: false,
      },
      methods: {
        'fixture.snapshot': { description: 'Snapshot', inputSchema: LABEL_SCHEMA, timeoutSeconds: 5, maxAttempts: 1, backoffSeconds: [], concurrencyKeys: ['collector:{collector}'] },
        'fixture.unstable': { description: 'Retry once', inputSchema: EMPTY_SCHEMA, timeoutSeconds: 5, maxAttempts: 2, backoffSeconds: [0], concurrencyKeys: ['collector:{collector}'] },
        'fixture.sync': { description: 'Sync one fixture pass', inputSchema: SYNC_SCHEMA, timeoutSeconds: 5, maxAttempts: 2, backoffSeconds: [0], concurrencyKeys: ['collector:{collector}'] },
      },
    }],
    sources: [{ id: 'fixture-main', collector: 'fixture', authProfile: null, config: { tenant: 'main' }, enabled: true }],
    plans: [
      { id: 'fixture-snapshot', source: 'fixture-main', method: 'fixture.snapshot', schedule: { type: 'manual' }, input: {}, dependsOn: [], enabled: true },
      { id: 'fixture-retry', source: 'fixture-main', method: 'fixture.unstable', schedule: { type: 'manual' }, input: {}, dependsOn: [], enabled: true },
      { id: 'fixture-interval', source: 'fixture-main', method: 'fixture.snapshot', schedule: { type: 'interval', seconds: 10 }, input: { label: 'scheduled' }, dependsOn: [], enabled: true },
      { id: 'fixture-sync-plan', source: 'fixture-main', method: 'fixture.sync', schedule: { type: 'manual' }, input: { behavior: 'no_change', label: 'sync' }, dependsOn: [], enabled: true },
    ],
    syncs: [{
      id: 'fixture-main-sync', plan: 'fixture-sync-plan', intervalSeconds: 10, jitterSeconds: 0,
      overlap: 'coalesce', settingsSchema: SYNC_SCHEMA,
      settings: { behavior: 'no_change', label: 'sync' }, desiredState: 'stopped',
    }],
  };
}

module.exports = { fixture, spec, FIXTURE_COLLECTOR };
