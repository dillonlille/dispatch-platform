'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { StandardCollectionService } = require('dispatch-runtime-kit/collection-manager/src/standard-collections');
const { LocalSyncManagerPort } = require('dispatch-runtime-kit/adapters/local/sync-manager-port');
const { SyncClient } = require('dispatch-runtime-kit/sdk/src/sync-client');
const { DispatchError, boundedJson } = require('../../sdk/src/protocol');
const { recordEvent } = require('./runtime-events');
const fail = code => { throw new DispatchError(code); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createRuntimeServices({ dspRoot, manifestFor, timezoneFor, wake, invoke, published }) {
  if ([dspRoot, manifestFor, timezoneFor, wake, invoke, published].some(fn => typeof fn !== 'function')) throw new TypeError('plugin_service_dependencies_required');
  function paths(context) {
    const root = dspRoot(context.dspId), databaseRoot = path.join(root, 'data/collection-manager');
    return { databaseRoot, database: path.join(databaseRoot, 'collection-manager.sqlite3'), stateRoot: path.join(root, 'state/collection-manager') };
  }
  function withStore(context, write, work) {
    const store = new CollectionStore(paths(context), { readOnly: !write, plugins: [manifestFor(context)] });
    try { return work(store, manifestFor(context)); } finally { store.close(); }
  }
  function ownRun(store, manifest, id) {
    const run = store.run(id);
    if (!manifest.collectors.includes(run.collector)) fail('job_not_found');
    return run;
  }
  function mutate(context, operation, input, work) {
    const value = withStore(context, true, (store, manifest) => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS plugin_sdk_requests(
        plugin_id TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,PRIMARY KEY(plugin_id,key)) STRICT;`);
      return store.transaction(() => {
        const digest = hash({ operation, input });
        const saved = store.db.prepare('SELECT request_hash,response_json FROM plugin_sdk_requests WHERE plugin_id=? AND key=?')
          .get(context.pluginId, input.idempotencyKey);
        if (saved) {
          if (saved.request_hash !== digest) fail('idempotency_conflict');
          return JSON.parse(saved.response_json);
        }
        if (store.db.prepare('SELECT count(*) n FROM plugin_sdk_requests WHERE plugin_id=?').get(context.pluginId).n >= 10000) fail('plugin_request_capacity');
        const result = boundedJson(work(store, manifest));
        store.db.prepare('INSERT INTO plugin_sdk_requests VALUES(?,?,?,?,?)')
          .run(context.pluginId, input.idempotencyKey, digest, JSON.stringify(result), Date.now());
        return result;
      });
    });
    wake(context.dspId); return value;
  }
  return {
    'jobs.enqueue': (context, input) => mutate(context, 'jobs.enqueue', input, (store, manifest) => {
      if (!(manifest.jobs || []).includes(input.action)) fail('permission_denied');
      const plan = store.plan(input.action), source = store.source(plan.source);
      if (!manifest.collectors.includes(source.collector)) fail('permission_denied');
      return store.enqueuePlan(input.action, { input: input.input, logicalKey: 'sdk:' + hash([context.pluginId, input.idempotencyKey]) });
    }),
    'jobs.status': (context, { id }) => withStore(context, false, (store, manifest) => ownRun(store, manifest, id)),
    'jobs.cancel': (context, input) => mutate(context, 'jobs.cancel', input, (store, manifest) => {
      const run = ownRun(store, manifest, input.id);
      return ['queued', 'running'].includes(run.status) ? store.cancel(input.id) : run;
    }),
    'jobs.retry': (context, input) => mutate(context, 'jobs.retry', input, (store, manifest) => {
      ownRun(store, manifest, input.id); return store.retry(input.id);
    }),
    'schedules.list': context => withStore(context, false, (store, manifest) => ({ items: store.collectionSchedules()
      .filter(item => manifest.collectors.includes(store.source(item.request.source).collector)) })),
    'schedules.status': async (context, { id }) => {
      if (!manifestFor(context).syncs.includes(id)) fail('permission_denied');
      return { timezone: timezoneFor(context.dspId), result: await new SyncClient({ port: new LocalSyncManagerPort({ paths: paths(context) }) }).status(id) };
    },
    'schedules.run': async (context, { id, options }) => {
      if (!manifestFor(context).syncs.includes(id)) fail('permission_denied');
      const result = await new SyncClient({ port: new LocalSyncManagerPort({ paths: paths(context) }) }).runNow(id, options);
      wake(context.dspId); return result;
    },
    'schedules.set': (context, input) => mutate(context, 'schedules.set', input, (store, manifest) => {
      const definition = { ...input.definition, id: input.id };
      if (!definition.request || !manifest.collectors.includes(store.source(definition.request.source).collector)) fail('permission_denied');
      const before = store.db.prepare('SELECT 1 FROM collection_schedules WHERE id=?').get(input.id);
      if (before && !manifest.collectors.includes(store.source(store.collectionSchedule(input.id).request.source).collector)) fail('permission_denied');
      return new StandardCollectionService(store).putSchedule(definition);
    }),
    'schedules.remove': (context, input) => mutate(context, 'schedules.remove', input, (store, manifest) => {
      const before = store.collectionSchedule(input.id);
      if (!manifest.collectors.includes(store.source(before.request.source).collector)) fail('permission_denied');
      store.removeCollectionSchedule(input.id); return { removed: true };
    }),
    'actions.invoke': (context, { action, input }, options) => invoke(context, action, input, options),
    'published.read': (context, { view, query }, options) => published(context, view, query, options),
    'progress.report': (context, input) => recordEvent(dspRoot(context.dspId), context, 'progress', input.event),
    'log.write': (context, input) => recordEvent(dspRoot(context.dspId), context, 'log', input.event),
  };
}
module.exports = { createRuntimeServices };
