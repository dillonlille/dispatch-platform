"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  CollectionStore,
} = require("dispatch-runtime-kit/collection-manager/src/store");
const {
  CollectionManager,
} = require("dispatch-dsp/runtime/collection-manager/src/manager.js");
const {
  SyncService,
} = require("dispatch-runtime-kit/collection-manager/src/syncs");
const { spec } = require("dispatch-dsp/runtime/collection-manager/tests/helpers.js");
const { settingsStore } = require("../settings-store");
const {
  initializeSettings,
  applySettingsPolicy,
} = require("../settings-policy");
test("settings pause automatic work, retain queued manual work, and preserve independent DSP schedules", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "dispatch-settings-policy-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    id: "example", version: "1.0.0", collectors: ["fixture"], syncs: ["fixture-main-sync"],
    settings: {
      version: 1,
      sections: [{ id: "sync", label: "Sync" }],
      fields: [
        {
          id: "enabled",
          section: "sync",
          label: "Automatic",
          type: "boolean",
          default: true,
        },
        {
          id: "interval",
          section: "sync",
          label: "Interval",
          type: "integer",
          minimum: 10,
          maximum: 100,
          default: 10,
        },
      ],
      schedule: {
        id: "fixture-main-sync",
        enabled: "enabled",
        interval: "interval",
      },
    },
  };
  const stores = ["a", "b"].map((id) => {
    const databaseRoot = path.join(root, id, "data/collection-manager");
    fs.mkdirSync(path.dirname(databaseRoot), { recursive: true, mode: 0o700 });
    return new CollectionStore({
      databaseRoot,
      database: path.join(databaseRoot, "collection-manager.sqlite3"),
      stateRoot: path.join(root, id, "state"),
    });
  });
  t.after(() => stores.forEach((store) => store.close()));
  for (const [index, store] of stores.entries()) {
    store.applySpec(spec());
    new SyncService(store).start("fixture-main-sync", { runNow: false });
    initializeSettings(path.join(root, index ? "b" : "a"), manifest);
    applySettingsPolicy(path.join(root, index ? "b" : "a"), manifest);
  }
  const [a, b] = stores,
    service = new SyncService(a),
    storage = settingsStore(path.join(root, "a"), "example");
  const queued = a.enqueueSync("fixture-main-sync", {
    trigger: "sync_schedule",
    timestamp: Date.now(),
    windowKey: "before-pause",
  });
  const save = (values) => {
    const before = storage.read(manifest.settings);
    storage.update(
      manifest.settings,
      {
        values,
        expectedRevision: before.revision,
        definitionVersion: 1,
        idempotencyKey: "settings:" + before.revision,
      },
      "owner_a",
    );
    return applySettingsPolicy(path.join(root, "a"), manifest);
  };
  save({ enabled: false, interval: 30 });
  assert.equal(a.run(queued.id).status, "cancelled");
  assert.equal(a.sync("fixture-main-sync").desiredState, "stopped");
  assert.equal(a.sync("fixture-main-sync").intervalSeconds, 30);
  assert.equal(b.sync("fixture-main-sync").intervalSeconds, 10);
  assert.equal(b.sync("fixture-main-sync").desiredState, "running");
  const manual = service.runNow("fixture-main-sync", {
    idempotencyKey: "paused-click",
  }).run;
  assert.equal(
    service.runNow("fixture-main-sync", { idempotencyKey: "paused-click" }).run
      .id,
    manual.id,
  );
  save({ enabled: false, interval: 40 });
  assert.equal(a.run(manual.id).status, "queued");
  const manager = new CollectionManager(a, { tickMs: 10 });
  t.after(() => manager.stop());
  await manager.start();
  await manager.runUntilIdle({ timeoutMs: 5000 });
  await manager.stop();
  assert.equal(a.run(manual.id).status, "succeeded");
  assert.equal(a.sync("fixture-main-sync").desiredState, "stopped");
  initializeSettings(path.join(root, "a"), manifest);
  assert.deepEqual(storage.read(manifest.settings).values, {
    enabled: false,
    interval: 40,
  });
  save({ enabled: true, interval: 40 });
  assert.equal(a.sync("fixture-main-sync").desiredState, "running");
  assert.ok(a.sync("fixture-main-sync").nextDueAt > Date.now());
  const scheduled = a.enqueueSync("fixture-main-sync", {trigger:"sync_schedule",timestamp:Date.now()+40000,windowKey:"manual-coalesced"});
  assert.equal(service.runNow("fixture-main-sync",{idempotencyKey:"manual-coalesced"}).run.id,scheduled.id);
  save({enabled:false,interval:40});
  assert.equal(a.run(scheduled.id).status,"queued");
});
