'use strict';

const { catalog, plugin } = require('dispatch-protocol/plugin-sdk/catalog');
const { pluginRequest } = require('dispatch-protocol/plugin-sdk/contract');
function fail(code) { throw Object.assign(new Error(code), { code }); }
const definitions = new WeakMap();
function configurePluginState(db, plugins) { if(plugins)definitions.set(db,plugins); }
const catalogFor = db => definitions.get(db) || catalog();
function initializePluginState(db, plugins) {
  configurePluginState(db,plugins);
  db.exec(`CREATE TABLE IF NOT EXISTS plugin_installations (
    plugin_id TEXT PRIMARY KEY, version TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('enabled','disabled','uninstalled')),
    revision INTEGER NOT NULL CHECK(revision>=0), prior_sync_json TEXT NOT NULL DEFAULT '{}'
  ) STRICT;`);
  // This executes before the first manager tick. Only already registered
  // collectors count as legacy runtime enrollment; shipped files never do.
  for (const definition of catalogFor(db)) {
    const enrolled = definition.collectors.some(id => db.prepare('SELECT 1 FROM collectors WHERE id=?').get(id));
    db.prepare(`INSERT OR IGNORE INTO plugin_installations(plugin_id,version,state,revision)
      VALUES(?,?,?,0)`).run(definition.id, definition.version, enrolled ? 'enabled' : 'uninstalled');
  }
}
function installation(db, id) {
  const row = db.prepare('SELECT * FROM plugin_installations WHERE plugin_id=?').get(id);
  if (!row) fail('plugin_not_found');
  return { id: row.plugin_id, version: row.version, state: row.state, revision: row.revision };
}
function collectorEnabled(db, id) {
  const owner = catalogFor(db).find(item => item.collectors.includes(id));
  return !owner || installation(db, owner.id).state === 'enabled';
}
function applyState(store, value) {
  const find = id => catalogFor(store.db).find(item => item.id===id);
  const input = pluginRequest(value,find);
  const definition = find(input.pluginId);
  return store.transaction(() => {
    const before = installation(store.db, definition.id);
    if (before.revision > input.revision || before.revision === input.revision && before.state !== input.state) fail('plugin_revision_conflict');
    if (before.revision === input.revision) return before;
    let prior = JSON.parse(store.db.prepare('SELECT prior_sync_json FROM plugin_installations WHERE plugin_id=?').get(definition.id).prior_sync_json);
    if (input.state !== 'enabled') {
      if (before.state === 'enabled') {
        prior = {};
        for (const id of definition.syncs) {
          const sync = store.db.prepare('SELECT desired_state FROM sync_definitions WHERE id=?').get(id);
          if (sync) prior[id] = sync.desired_state;
        }
      }
      for (const id of definition.syncs) store.db.prepare(`UPDATE sync_definitions SET desired_state='stopped',
        generation=generation+1,next_due_at=NULL,updated_at=? WHERE id=? AND desired_state<>'stopped'`).run(Date.now(), id);
      for (const id of definition.collectors) {
        store.db.prepare(`UPDATE runs SET status='cancelled',finished_at=?,error_code='plugin_disabled'
          WHERE collector_id=? AND status='queued'`).run(Date.now(), id);
        store.db.prepare(`UPDATE runs SET cancel_requested=1 WHERE collector_id=? AND status='running'`).run(id);
      }
    } else if (before.state !== 'enabled') {
      for (const [id, state] of Object.entries(prior)) {
        if (!definition.syncs.includes(id) || !['running', 'stopped'].includes(state)) fail('plugin_state_invalid');
        store.db.prepare(`UPDATE sync_definitions SET desired_state=?,generation=generation+1,
          next_due_at=CASE WHEN ?='running' THEN ? ELSE NULL END,updated_at=? WHERE id=?`)
          .run(state, state, Date.now(), Date.now(), id);
      }
    }
    store.db.prepare(`UPDATE plugin_installations SET state=?,version=?,revision=?,prior_sync_json=? WHERE plugin_id=?`)
      .run(input.state, input.version, input.revision, JSON.stringify(prior), definition.id);
    return installation(store.db, definition.id);
  });
}
module.exports = { configurePluginState, initializePluginState, installation, collectorEnabled, applyState };
