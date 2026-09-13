"use strict";
const path = require("node:path");
const {
  CollectionStore,
} = require("dispatch-runtime-kit/collection-manager/src/store");
const { settingsStore } = require("./settings-store");

function applySettingsPolicy(dspRoot, manifest, { start = true } = {}) {
  if (!manifest.settings) return null;
  const storage = settingsStore(dspRoot, manifest.id),
    current = storage.read(manifest.settings);
  if (current.appliedRevision === current.revision) return current;
  const binding = manifest.settings.schedule;
  if (binding) {
    const databaseRoot = path.join(dspRoot, "data/collection-manager");
    const collections = new CollectionStore({
      databaseRoot,
      database: path.join(databaseRoot, "collection-manager.sqlite3"),
    }, { plugins: [manifest] });
    try {
      if (
        !collections.db
          .prepare("SELECT 1 FROM sync_definitions WHERE id=?")
          .get(binding.id)
      )
        return current;
      collections.transaction(() => {
        const before = collections.sync(binding.id),
          interval = current.values[binding.interval],
          enabled = current.values[binding.enabled];
        if (before.intervalSeconds !== interval)
          collections.editSync(binding.id, {
            intervalSeconds: interval,
            jitterSeconds: Math.min(before.jitterSeconds, interval - 1),
          });
        if (!enabled) {
          collections.setSyncDesiredState(binding.id, "stopped");
          for (const row of collections.db
            .prepare(
              `SELECT r.id FROM runs r JOIN sync_runs s ON s.run_id=r.id
            WHERE s.sync_id=? AND r.status='queued' AND s.trigger<>'sync_manual'`,
            )
            .all(binding.id))
            collections.cancel(row.id);
        } else if (start && before.desiredState !== "running") {
          collections.setSyncDesiredState(binding.id, "running", Date.now(), {
            incrementGeneration: true,
          });
          collections.setSyncNextDue(binding.id, Date.now() + interval * 1000);
        }
      });
    } finally {
      collections.close();
    }
  }
  storage.applied(current.revision);
  return storage.read(manifest.settings);
}
function initializeSettings(dspRoot, manifest) {
  if (!manifest.settings) return null;
  const seed = {},
    binding = manifest.settings.schedule;
  if (binding) {
    const { openDatabase } = require("../../shared/published/database");
    const db = openDatabase(
      path.join(dspRoot, "data/collection-manager/collection-manager.sqlite3"),
    );
    try {
      const row = db
        ?.prepare(
          "SELECT desired_state,interval_seconds FROM sync_definitions WHERE id=?",
        )
        .get(binding.id);
      if (row) {
        seed[binding.enabled] = row.desired_state === "running";
        seed[binding.interval] = row.interval_seconds;
      }
    } finally {
      db?.close();
    }
  }
  return settingsStore(dspRoot, manifest.id).initialize(
    manifest.settings,
    seed,
  );
}
module.exports = { applySettingsPolicy, initializeSettings };
