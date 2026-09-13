'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PaycomStore } = require('../src/store');
const { TIMECARD_SUMMARY } = require('../src/resource-links');

class LocalPaycomPublicationPort {
  #database;
  #storeFactory;

  constructor({ database = require('../src/paths').DATABASE, storeFactory = (file, options) => new PaycomStore(file, options) } = {}) {
    this.#database = database;
    this.#storeFactory = storeFactory;
  }

  health() {
    if (!fs.existsSync(this.#database)) return null;
    let store;
    try {
      store = this.#storeFactory(this.#database, { readOnly: true });
      return {
        payPeriods: store.audit('pay_periods'),
        roster: store.audit('roster'),
        timecards: store.audit('timecards'),
        resourceLinks: { kind: 'resource_links', ...store.auditResourceLinks(TIMECARD_SUMMARY) },
      };
    } finally {
      try { store?.close(); } catch {}
    }
  }
}

module.exports = { LocalPaycomPublicationPort };
