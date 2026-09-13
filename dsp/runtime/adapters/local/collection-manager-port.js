'use strict';

const fs = require('node:fs');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { defaultPaths } = require('dispatch-runtime-kit/collection-manager/src/paths');
const { StandardCollectionService } = require('dispatch-runtime-kit/collection-manager/src/standard-collections');

function unavailable(code) { throw Object.assign(new Error(code), { code }); }

class LocalCollectionManagerPort {
  #paths;
  #storeFactory;

  constructor({ paths = defaultPaths(), storeFactory = (value, options) => new CollectionStore(value, options) } = {}) {
    this.#paths = paths;
    this.#storeFactory = storeFactory;
  }

  #open(readOnly, action) {
    if (!fs.existsSync(this.#paths.database)) unavailable('collection_manager_not_initialized');
    let store;
    try {
      store = this.#storeFactory(this.#paths, { readOnly });
      return action(store);
    } finally {
      try { store?.close(); } catch {}
    }
  }

  async #openAsync(readOnly, action) {
    if (!fs.existsSync(this.#paths.database)) unavailable('collection_manager_not_initialized');
    let store;
    try {
      store = this.#storeFactory(this.#paths, { readOnly });
      return await action(store);
    } finally {
      try { store?.close(); } catch {}
    }
  }

  health() {
    if (!fs.existsSync(this.#paths.database)) return {
      ok: true,
      status: 'not_initialized',
      schemaVersion: null,
      databaseIntegrity: 'not_initialized',
      manager: { running: false, pid: null, heartbeatAt: null },
      counts: { collectors: 0, sources: 0, plans: 0, queued: 0, running: 0, failed: 0 },
      syncAlerts: { total: 0, critical: 0, items: [], hasMore: false },
    };
    return this.#open(true, store => store.health());
  }

  collectors() { return this.#open(true, store => store.collectors()); }
  collector(id) { return this.#open(true, store => store.collector(id)); }
  methods(collector) { return this.#open(true, store => store.methods(collector)); }
  method(collector, id) {
    return this.#open(true, store => {
      const value = store.methods(collector).find(item => item.id === id);
      if (!value) unavailable('method_not_found');
      return value;
    });
  }
  sources() { return this.#open(true, store => store.sources()); }
  source(id) { return this.#open(true, store => store.source(id)); }
  plans() { return this.#open(true, store => store.plans()); }
  plan(id) { return this.#open(true, store => store.plan(id)); }
  runs(limit, offset) { return this.#open(true, store => ({ items: store.runs(limit, offset), total: store.runCount() })); }
  run(runId) { return this.#open(true, store => store.run(runId)); }
  startRun(plan, input, logicalKey) { return this.#open(false, store => store.enqueuePlan(plan, { input, logicalKey })); }
  cancelRun(runId) { return this.#open(false, store => store.cancel(runId)); }
  retryRun(runId) { return this.#open(false, store => store.retry(runId)); }
  describeCollection(source) { return this.#open(true, store => new StandardCollectionService(store).describe(source)); }
  previewCollection(request, options) { return this.#openAsync(true, store => new StandardCollectionService(store).preview(request, options)); }
  enqueueCollection(request, options) {
    return this.#openAsync(false, async store => {
      const batch = await new StandardCollectionService(store).enqueue(request, options);
      return store.batchPage(batch.id, 50, 0);
    });
  }
  batches(limit, offset) { return this.#open(true, store => ({ items: store.batches(limit, offset), total: store.batchCount() })); }
  batch(id, limit = 50, offset = 0) { return this.#open(true, store => store.batchPage(id, limit, offset)); }
  cancelBatch(id, limit = 50, offset = 0) {
    return this.#open(false, store => { store.cancelBatch(id); return store.batchPage(id, limit, offset); });
  }
  retryBatch(id, limit = 50, offset = 0) {
    return this.#open(false, store => { store.retryBatch(id); return store.batchPage(id, limit, offset); });
  }
  collectionSchedules() { return this.#open(true, store => store.collectionSchedules()); }
  collectionSchedule(id) { return this.#open(true, store => store.collectionSchedule(id)); }
  putCollectionSchedule(definition) { return this.#open(false, store => new StandardCollectionService(store).putSchedule(definition)); }
  setCollectionScheduleEnabled(id, enabled) { return this.#open(false, store => store.setCollectionScheduleEnabled(id, enabled)); }
  removeCollectionSchedule(id) { return this.#open(false, store => store.removeCollectionSchedule(id)); }
  runCollectionSchedule(id) {
    return this.#openAsync(false, async store => {
      const batch = await new StandardCollectionService(store).runScheduleNow(id);
      return store.batchPage(batch.id, 50, 0);
    });
  }
}

module.exports = { LocalCollectionManagerPort };
