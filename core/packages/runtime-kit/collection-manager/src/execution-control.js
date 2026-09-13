'use strict';

const KEY = 'core_execution_v1';
const read = db => {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY);
  if (!row) return null;
  const value = JSON.parse(row.value);
  const integer = number => Number.isSafeInteger(number) && number >= 0;
  if (!value || Object.keys(value).sort().join(',') !== 'acknowledged,completedAt,draining,generation,requestedAt,version'
      || value.version !== 1 || !integer(value.generation) || typeof value.draining !== 'boolean'
      || value.acknowledged !== null && (!integer(value.acknowledged) || value.acknowledged > value.generation)
      || value.requestedAt !== null && !integer(value.requestedAt) || value.completedAt !== null && !integer(value.completedAt)) throw new Error('execution_control_invalid');
  return value;
};
const write = (db, value) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(value));

// The DSP retains its schedule definitions and idempotent queue. Core owns the
// clock in managed mode: no schedule fires without a durable tick request.
// A drain acknowledgement is written only by the manager, between ticks.
function command(store, action, scheduledAt = Date.now()) {
  return store.transaction(() => {
    let state = read(store.db);
    if (action === 'restore') { store.db.prepare('DELETE FROM meta WHERE key=?').run(KEY); return null; }
    state ||= { version: 1, generation: 0, draining: false, acknowledged: null, requestedAt: null, completedAt: null };
    if (action === 'drain') {
      if (!state.draining) { state.generation++; state.draining = true; state.acknowledged = null; }
    } else if (['adopt', 'tick', 'resume'].includes(action)) {
      state.draining = false; state.acknowledged = null;
      if (scheduledAt !== null && (state.requestedAt === null || scheduledAt > state.requestedAt)) state.requestedAt = scheduledAt;
    }
    write(store.db, state);
    return state;
  });
}
function acknowledge(store, generation) {
  store.transaction(() => {
    const state = read(store.db);
    if (state?.draining && state.generation === generation) { state.acknowledged = generation; write(store.db, state); }
  });
}
function complete(store, timestamp) {
  store.transaction(() => {
    const state = read(store.db);
    if (state) { state.completedAt = Math.max(state.completedAt || 0, timestamp); write(store.db, state); }
  });
}
module.exports = { read, command, acknowledge, complete };
