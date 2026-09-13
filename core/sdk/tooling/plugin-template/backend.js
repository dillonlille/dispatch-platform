'use strict';
const { definePlugin } = require('dispatch-sdk/plugin');
const { DispatchError } = require('dispatch-sdk/protocol');
const { actions } = require('../dispatch-plugin.json');

function database(dispatch) {
  return dispatch.storage.database('records');
}
module.exports = definePlugin({ actions,
  async initialize({ dispatch }) {
    database(dispatch).exec('CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL)');
    return true;
  },
  handlers: {
    async 'records.list'({ dispatch, input }) {
      const db = database(dispatch), limit = input.limit ?? 25, offset = input.offset ?? 0;
      const total = db.prepare('SELECT count(*) total FROM records').get().total;
      const items = db.prepare('SELECT id,text FROM records ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => ({ ...row }));
      return { items, total, limit, offset };
    },
    async 'records.add'({ dispatch, input }) {
      const settings = (await dispatch.settings.get()).values;
      if (!settings.allow_entries) throw new DispatchError('entries_paused');
      const db = database(dispatch), text = input.text.trim();
      if (!text) throw new DispatchError('invalid_input');
      db.prepare('INSERT INTO records(request_id,text) VALUES(?,?) ON CONFLICT(request_id) DO NOTHING').run(input.idempotencyKey, text);
      const saved = db.prepare('SELECT id,text FROM records WHERE request_id=?').get(input.idempotencyKey);
      if (saved.text !== text) throw new DispatchError('idempotency_conflict');
      return { ...saved };
    },
  },
});
