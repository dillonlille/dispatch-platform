"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  summarize,
  measureStorageUsage,
} = require("../src/backup-storage-usage");
test("storage counts each physical archive once, including retained DSPs and partial deletion, while sets reuse component totals", () => {
  const records = [
    { id: "core", kind: "core" },
    { id: "one", kind: "dsp", organization_id: "org_one" },
    {
      id: "removed",
      kind: "dsp",
      organization_id: "org_removed",
      deleted_at: 123,
    },
  ];
  const sets = [
    {
      id: "set1",
      members_json: JSON.stringify([
        { backupId: "core" },
        { backupId: "one" },
        { backupId: "one" },
      ]),
    },
    {
      id: "set2",
      members_json: JSON.stringify([
        { backupId: "core" },
        { backupId: "removed" },
      ]),
    },
  ];
  const result = summarize(
    {
      archives: { core: 100, one: 200, removed: 300, unassigned: 50 },
      sets: { set1: 10, set2: 20 },
      legacyBytes: 40,
    },
    records,
    sets,
  );
  assert.equal(result.bytes, 720);
  assert.equal(result.backupCount, 4);
  assert.deepEqual(result.core, { bytes: 100, backupCount: 1 });
  assert.equal(
    result.dsps.find((s) => s.organizationId === "org_removed").bytes,
    300,
  );
  assert.deepEqual(result.other, { bytes: 50, backupCount: 1 });
  assert.equal(result.sets[0].bytes, 310);
  assert.equal(result.sets[0].backupCount, 2);
  assert.equal(result.sets[1].bytes, 420);
  const remaining = summarize(
    { archives: { core: 100, one: 200 }, sets: { set1: 10 }, legacyBytes: 0 },
    records,
    sets,
  );
  assert.equal(remaining.bytes, 310);
  assert.equal(
    remaining.dsps.some((s) => s.organizationId === "org_removed"),
    false,
  );
});
test("storage totals include archives beyond the dashboard history limit", () => {
  const records = Array.from({ length: 1205 }, (_, i) => ({
    id: "id_" + i,
    kind: "dsp",
    organization_id: "org_one",
  }));
  const result = summarize(
    {
      archives: Object.fromEntries(records.map((r) => [r.id, 10])),
      sets: {},
      legacyBytes: 0,
    },
    records,
    [],
  );
  assert.equal(result.bytes, 12050);
  assert.equal(result.dsps[0].backupCount, 1205);
});
test("usage caches read-only scans, refreshes on changes, and preserves explicitly stale measurements on failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0,
    now = 1000,
    broken = false;
  const options = {
    config: { accountId: "a", bucket: "fixture" },
    workRoot: root,
    ownerUid: process.geteuid(),
    clock: () => now,
    records: [],
    sets: [],
    version: 1,
    storage: {
      usage: async () => {
        calls++;
        if (broken) throw Error("offline");
        return { archives: {}, sets: {}, legacyBytes: 42 };
      },
    },
  };
  assert.equal((await measureStorageUsage(options)).bytes, 42);
  await measureStorageUsage(options);
  assert.equal(calls, 1);
  options.version = 2;
  await measureStorageUsage(options);
  assert.equal(calls, 2);
  now += 300001;
  broken = true;
  const stale = await measureStorageUsage(options);
  assert.equal(stale.status, "stale");
  assert.equal(stale.bytes, 42);
  assert.equal(stale.checkedAt, 1000);
  options.config.bucket = "another-bucket";
  assert.deepEqual(await measureStorageUsage(options), {
    status: "unavailable",
    checkedAt: null,
  });
});
