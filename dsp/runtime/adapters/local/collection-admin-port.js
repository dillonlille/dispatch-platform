'use strict';

const fs = require('node:fs');
const { CollectionStore, safeExecutable } = require('dispatch-runtime-kit/collection-manager/src/store');
const { defaultPaths } = require('dispatch-runtime-kit/collection-manager/src/paths');
const { validateSpec } = require('dispatch-runtime-kit/collection-manager/src/validation');
const { materializeSpec } = require('../../collection-manager/src/control-cli');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function expectedAttestation(spec) {
  const methods = [];
  for (const collector of spec.collectors) {
    for (const [id, method] of Object.entries(collector.methods)) {
      methods.push({
        collector: collector.id,
        id,
        description: method.description,
        inputSchema: method.inputSchema,
        timeoutSeconds: method.timeoutSeconds,
        maxAttempts: method.maxAttempts,
        backoffSeconds: method.backoffSeconds,
        concurrencyKeys: method.concurrencyKeys,
      });
    }
  }
  methods.sort((left, right) => `${left.collector}\0${left.id}`.localeCompare(`${right.collector}\0${right.id}`));
  const byMethod = new Map(methods.map(method => [`${method.collector}\0${method.id}`, method]));
  const sourceCollector = new Map(spec.sources.map(source => [source.id, source.collector]));
  return {
    collectors: spec.collectors.map(collector => ({
      id: collector.id,
      version: collector.version,
      description: collector.description,
      command: collector.command,
      sourceSchema: collector.sourceSchema,
      enabled: true,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    methods,
    sources: spec.sources.map(source => ({
      id: source.id,
      collector: source.collector,
      authProfile: source.authProfile,
      config: source.config,
      collection: source.collection || null,
      enabled: source.enabled,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    plans: spec.plans.map(plan => {
      const method = byMethod.get(`${sourceCollector.get(plan.source)}\0${plan.method}`);
      return {
        id: plan.id,
        source: plan.source,
        method: plan.method,
        schedule: plan.schedule,
        input: plan.input,
        dependsOn: plan.dependsOn,
        enabled: plan.enabled,
        timeoutSeconds: plan.timeoutSeconds || method.timeoutSeconds,
        maxAttempts: plan.maxAttempts || method.maxAttempts,
      };
    }).sort((left, right) => left.id.localeCompare(right.id)),
    syncs: (spec.syncs || []).map(sync => ({
      id: sync.id,
      plan: sync.plan,
      desiredState: sync.desiredState,
      intervalSeconds: sync.intervalSeconds,
      jitterSeconds: sync.jitterSeconds,
      overlap: sync.overlap,
      settingsSchema: sync.settingsSchema,
      settings: sync.settings,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function actualAttestation(store) {
  return {
    collectors: store.collectors().map(({ updatedAt, ...collector }) => collector),
    methods: store.methods(),
    sources: store.sources().map(({ updatedAt, ...source }) => source),
    plans: store.plans().map(({ nextDueAt, updatedAt, ...plan }) => plan),
    syncs: store.syncs(100, 0).map(sync => ({
      id: sync.id,
      plan: sync.plan,
      desiredState: sync.desiredState,
      intervalSeconds: sync.intervalSeconds,
      jitterSeconds: sync.jitterSeconds,
      overlap: sync.overlap,
      settingsSchema: sync.settingsSchema,
      settings: sync.settings,
    })),
  };
}

class LocalCollectionAdminPort {
  #paths;
  #storeFactory;

  constructor({ paths = defaultPaths(), storeFactory = (value, options) => new CollectionStore(value, options) } = {}) {
    this.#paths = paths;
    this.#storeFactory = storeFactory;
  }

  #open(readOnly, action) {
    let store;
    try {
      store = this.#storeFactory(this.#paths, { readOnly });
      return action(store);
    } finally {
      try { store?.close(); } catch {}
    }
  }

  #prepare(spec) {
    const value = materializeSpec(clone(spec), this.#paths.projectRoot);
    validateSpec(value);
    for (const collector of value.collectors) safeExecutable(collector.command);
    return value;
  }

  inspect() {
    if (!fs.existsSync(this.#paths.database)) return {
      initialized: false, schemaVersion: null,
      counts: { collectors: 0, sources: 0, plans: 0, syncs: 0 },
    };
    return this.#open(true, store => {
      const health = store.health();
      return {
        initialized: true,
        schemaVersion: health.schemaVersion,
        counts: {
          collectors: store.collectors().length,
          sources: store.sources().length,
          plans: store.plans().length,
          syncs: store.syncCount(),
        },
      };
    });
  }

  initialize() {
    return this.#open(false, store => {
      const health = store.health();
      return {
        initialized: true,
        schemaVersion: health.schemaVersion,
        counts: {
          collectors: store.collectors().length,
          sources: store.sources().length,
          plans: store.plans().length,
          syncs: store.syncCount(),
        },
      };
    });
  }

  preview(spec) {
    const value = this.#prepare(spec);
    const existing = this.inspect();
    const incoming = {
      collectors: value.collectors.length,
      sources: value.sources.length,
      plans: value.plans.length,
      syncs: (value.syncs || []).length,
    };
    if (!existing.initialized) return {
      valid: true, incoming,
      changes: Object.fromEntries(Object.entries(incoming).map(([key, count]) => [key, { create: count, update: 0 }])),
    };
    return this.#open(true, store => {
      const syncRows = [];
      for (let offset = 0; ; offset += 100) {
        const page = store.syncs(100, offset);
        syncRows.push(...page);
        if (page.length < 100) break;
      }
      const current = {
        collectors: new Set(store.collectors().map(item => item.id)),
        sources: new Set(store.sources().map(item => item.id)),
        plans: new Set(store.plans().map(item => item.id)),
        syncs: new Set(syncRows.map(item => item.id)),
      };
      const items = { collectors: value.collectors, sources: value.sources, plans: value.plans, syncs: value.syncs || [] };
      const changes = Object.fromEntries(Object.entries(items).map(([key, rows]) => {
        const update = rows.filter(item => current[key].has(item.id)).length;
        return [key, { create: rows.length - update, update }];
      }));
      return { valid: true, incoming, changes };
    });
  }

  apply(spec) {
    const value = this.#prepare(spec);
    return this.#open(false, store => store.applySpec(value));
  }

  attest(spec) {
    const value = this.#prepare(spec);
    const expected = expectedAttestation(value);
    return this.#open(true, store => ({ matched: same(actualAttestation(store), expected) }));
  }
}

module.exports = { LocalCollectionAdminPort };
