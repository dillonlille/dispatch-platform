"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { DatabaseSync } = require("node:sqlite");
const { settingsStore } = require("../settings-store");
const definition = {
  version: 1,
  sections: [{ id: "view", label: "View" }],
  fields: [
    {
      id: "order",
      section: "view",
      label: "Order",
      type: "string",
      default: "first",
    },
    {
      id: "rows",
      section: "view",
      label: "Rows",
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 25,
    },
  ],
};
function root(t) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "smarter-settings-"));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  return r;
}
function update(storage, d, values, sources, id) {
  const s = storage.read(d);
  return storage.update(
    d,
    {
      values,
      ...(sources ? { sources } : {}),
      expectedRevision: s.revision,
      definitionVersion: d.version,
      idempotencyKey: id || "save:" + s.revision,
    },
    "owner_fixture",
  );
}
test("owner intent is preserved even when the override equals the default; untouched DSPs follow new defaults", (t) => {
  const r = root(t),
    a = settingsStore(path.join(r, "a"), "sample"),
    b = settingsStore(path.join(r, "b"), "sample");
  a.initialize(definition);
  b.initialize(definition);
  const saved = update(
    a,
    definition,
    { order: "first", rows: 25 },
    { order: "override", rows: "default" },
  );
  assert.equal(saved.revision, 1);
  assert.equal(saved.sources.order, "override");
  const next = {
    ...definition,
    version: 2,
    fields: definition.fields.map((f) =>
      f.id === "order" ? { ...f, default: "last" } : f,
    ),
  };
  assert.equal(a.initialize(next).values.order, "first");
  assert.equal(b.initialize(next).values.order, "last");
  assert.equal(a.initialize(next).sources.order, "override");
  assert.throws(
    () =>
      update(
        a,
        next,
        { order: "first", rows: 25 },
        { order: "default", rows: "default" },
      ),
    /settings_invalid/,
  );
  const reset = update(
    a,
    next,
    { order: "last", rows: 25 },
    { order: "default", rows: "default" },
  );
  assert.equal(reset.sources.order, "default");
  assert.equal(
    settingsStore(path.join(r, "a"), "sample").initialize(next).revision,
    reset.revision,
  );
});
test("legacy SQLite rows are conservatively upgraded without guessing intent or changing other values", (t) => {
  const r = root(t),
    dir = path.join(r, "config/plugins/sample");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, "settings.sqlite3"));
  db.exec(
    "CREATE TABLE settings(id INTEGER PRIMARY KEY,version INTEGER,revision INTEGER,values_json TEXT,updated_at INTEGER,actor TEXT,applied_revision INTEGER);CREATE TABLE history(revision INTEGER PRIMARY KEY,version INTEGER,values_json TEXT,updated_at INTEGER,actor TEXT);",
  );
  const values = JSON.stringify({ order: "first", rows: 50 });
  db.prepare("INSERT INTO settings VALUES(1,1,4,?,1,NULL,4)").run(values);
  db.prepare("INSERT INTO history VALUES(4,1,?,1,NULL)").run(values);
  db.close();
  fs.chmodSync(path.join(dir, "settings.sqlite3"), 0o600);
  const storage = settingsStore(r, "sample"),
    same = storage.initialize(definition);
  assert.deepEqual(same.values, { order: "first", rows: 50 });
  assert.deepEqual(same.sources, { order: "override", rows: "override" });
  assert.equal(same.revision, 4);
  const next = {
    ...definition,
    version: 2,
    fields: definition.fields.map((f) =>
      f.id === "order" ? { ...f, default: "last" } : f,
    ),
  };
  const migrated = storage.initialize(next);
  assert.deepEqual(migrated.values, same.values);
  assert.equal(migrated.revision, 5);
  const broken = {
    ...next,
    version: 3,
    fields: next.fields.map((f) =>
      f.id === "rows" ? { ...f, maximum: 30 } : f,
    ),
  };
  assert.throws(() => storage.initialize(broken), /settings_invalid/);
  assert.deepEqual(storage.read(next), migrated);
  assert.equal(
    storage.history(next).items.find((item) => item.revision === 4).canRestore,
    false,
  );
});
test("history is paginated and scoped; source-only changes and retry receipts are durable", (t) => {
  const r = root(t),
    a = settingsStore(path.join(r, "a"), "sample"),
    b = settingsStore(path.join(r, "b"), "sample");
  a.initialize(definition);
  b.initialize(definition);
  const initial = a.read(definition);
  const request = {
    values: initial.values,
    sources: { order: "override", rows: "default" },
    expectedRevision: 0,
    definitionVersion: 1,
    idempotencyKey: "same:value",
  };
  a.update(definition, request, "owner_fixture");
  assert.equal(a.update(definition, request, "owner_fixture").revision, 1);
  assert.throws(
    () =>
      a.update(
        definition,
        { ...request, sources: initial.sources },
        "owner_fixture",
      ),
    /idempotency_conflict/,
  );
  for (let rows = 26; rows < 39; rows++)
    update(
      a,
      definition,
      { order: "first", rows },
      { order: "override", rows: "override" },
    );
  const first = a.history(definition);
  assert.equal(first.items.length, 10);
  assert(first.nextBefore !== null);
  const second = a.history(definition, { beforeRevision: first.nextBefore });
  assert(second.items.every((item) => item.revision < first.nextBefore));
  assert.equal(second.nextBefore, null);
  const intent = second.items.find((item) => item.revision === 1);
  assert.equal(intent.changes.length, 1);
  assert.equal(intent.changes[0].beforeSource, "default");
  assert.equal(intent.changes[0].afterSource, "override");
  assert.equal(b.history(definition).items.length, 1);
  assert.throws(
    () => a.history(definition, { beforeRevision: -1 }),
    /settings_invalid/,
  );
});
test("large valid settings histories stay within the SDK response envelope", (t) => {
  const r = root(t),
    a = settingsStore(r, "sample");
  const d = {
    version: 1,
    sections: definition.sections,
    fields: Array.from({ length: 16 }, (_, i) => ({
      id: "groups_" + i,
      section: "view",
      label: "Groups " + i,
      type: "strings",
      default: Array.from({ length: 200 }, (_, n) => "g" + n),
    })),
  };
  a.initialize(d);
  for (let i = 0; i < 8; i++) {
    const before = a.read(d);
    update(
      a,
      d,
      { ...before.values, groups_0: [...before.values.groups_0].reverse() },
      undefined,
      "large:" + i,
    );
  }
  const history = a.history(d);
  assert(history.items.length > 0 && history.nextBefore !== null);
  const { result, unwrap } = require("../../../sdk/src/protocol");
  assert.equal(unwrap(result(history)).items.length, history.items.length);
  assert.equal(history.items[0].values.groups_0.length, 200);
});
