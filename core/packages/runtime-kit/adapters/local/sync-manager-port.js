'use strict';

const fs = require('node:fs');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { defaultPaths } = require('dispatch-runtime-kit/collection-manager/src/paths');
const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');

function unavailable(code) { throw Object.assign(new Error(code), { code }); }

class LocalSyncManagerPort {
  #paths;
  #storeFactory;
  #serviceFactory;

  constructor({
    paths = defaultPaths(),
    storeFactory = (value, options) => new CollectionStore(value, options),
    serviceFactory = store => new SyncService(store),
  } = {}) {
    this.#paths = paths;
    this.#storeFactory = storeFactory;
    this.#serviceFactory = serviceFactory;
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


  syncs(limit, offset) {
    return this.#open(true, store => ({ items: store.syncs(limit, offset), total: store.syncCount() }));
  }

  sync(id) { return this.#open(true, store => store.sync(id)); }
  authentication(id) {
    return this.#open(true, store => {
      const sync = store.sync(id);
      const source = store.source(sync.source);
      return source.authProfile === null
        ? { required: false, profile: null, provider: null }
        : { required: true, profile: source.authProfile, provider: source.collector };
    });
  }
  history(id, limit, offset) { return this.#open(true, store => store.syncHistory(id, limit, offset)); }
  start(id) { return this.#openAsync(false, store => this.#serviceFactory(store).start(id)); }
  stop(id, options) { return this.#openAsync(false, store => this.#serviceFactory(store).stop(id, options)); }
  restart(id, options) { return this.#openAsync(false, store => this.#serviceFactory(store).restart(id, options)); }
  runNow(id, options) { return this.#openAsync(false, store => this.#serviceFactory(store).runNow(id, options)); }
  edit(id, patch, options) { return this.#openAsync(false, store => this.#serviceFactory(store).edit(id, patch, options)); }
}

module.exports = { LocalSyncManagerPort };
