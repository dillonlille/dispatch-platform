"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { settingsStore } = require("../settings-store");
const {
  validateSettingsDefinition,
  settingsValues,
  migrateSettings,
} = require("../../../sdk/src/settings");
const definition = {
  version: 1,
  sections: [{ id: "general", label: "General" }],
  fields: [
    {
      id: "selected",
      label: "Selected departments",
      section: "general",
      type: "strings",
      nullable: true,
      default: null,
    },
    {
      id: "frequency",
      label: "Frequency",
      section: "general",
      type: "integer",
      minimum: 10,
      maximum: 100,
      default: 30,
    },
  ],
};
test("SDK settings validate declarations and values, reject identity/path extras and preserve empty selections", () => {
  const schema = validateSettingsDefinition(definition);
  assert.deepEqual(settingsValues(schema, {}, { defaults: true }), {
    selected: null,
    frequency: 30,
  });
  assert.deepEqual(settingsValues(schema, { selected: [], frequency: 30 }), {
    selected: [],
    frequency: 30,
  });
  assert.throws(
    () =>
      settingsValues(schema, { selected: [], frequency: 30, dspId: "other" }),
    /settings_invalid/,
  );
  assert.throws(
    () => settingsValues(schema, { selected: ["x", "x"], frequency: 30 }),
    /settings_invalid/,
  );
  assert.throws(
    () => settingsValues(schema, { selected: [], frequency: 1 }),
    /settings_invalid/,
  );
  assert.throws(
    () =>
      validateSettingsDefinition({
        ...definition,
        fields: [{ ...definition.fields[1], default: 999 }],
      }),
    /settings_invalid/,
  );
});
test("DSP settings survive reopen, isolate identical plugin ids, reject stale writes and audit idempotent edits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of ["a", "b"])
    fs.mkdirSync(path.join(root, id, "config/plugins"), {
      recursive: true,
      mode: 0o700,
    });
  const a = settingsStore(path.join(root, "a"), "example"),
    b = settingsStore(path.join(root, "b"), "example");
  a.initialize(definition);
  b.initialize(definition);
  const input = {
    values: { selected: ["D1"], frequency: 50 },
    expectedRevision: 0,
    definitionVersion: 1,
    idempotencyKey: "save:one",
  };
  assert.equal(a.update(definition, input, "owner_a").revision, 1);
  assert.equal(a.update(definition, input, "owner_a").revision, 1);
  assert.deepEqual(b.read(definition).values, {
    selected: null,
    frequency: 30,
  });
  assert.deepEqual(
    settingsStore(path.join(root, "a"), "example").read(definition).values,
    input.values,
  );
  assert.throws(
    () =>
      a.update(definition, { ...input, idempotencyKey: "save:two" }, "owner_a"),
    /settings_revision_conflict/,
  );
  assert.throws(
    () =>
      a.update(
        definition,
        { ...input, values: { selected: [], frequency: 30 } },
        "owner_a",
      ),
    /idempotency_conflict/,
  );
  assert.throws(
    () => a.update(definition, input, "owner_b"),
    /idempotency_conflict/,
  );
  a.applied(0);
  assert.equal(a.read(definition).appliedRevision, -1);
  a.applied(1);
  assert.equal(a.read(definition).appliedRevision, 1);
});
test("future plugin schema upgrades preserve DSP overrides, add defaults, and support declared renames", () => {
  const next = validateSettingsDefinition({
    ...definition,
    version: 2,
    fields: [
      { ...definition.fields[0], id: "departments" },
      definition.fields[1],
      {
        id: "enabled",
        label: "Enabled",
        section: "general",
        type: "boolean",
        default: true,
      },
    ],
    migrations: [{ fromVersion: 1, rename: { selected: "departments" } }],
  });
  assert.deepEqual(migrateSettings(next, { selected: [], frequency: 70 }, 1), {
    departments: [],
    frequency: 70,
    enabled: true,
  });
  assert.throws(
    () => migrateSettings(next, { selected: [], frequency: 70 }, 3),
    /settings_incompatible/,
  );
});

test('initialization migrates stored overrides once and rejects incompatible schema changes without partial writes', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-settings-upgrade-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const storage=settingsStore(root,'example');storage.initialize(definition);
  storage.update(definition,{values:{selected:[],frequency:70},expectedRevision:0,definitionVersion:1,idempotencyKey:'settings:before-upgrade'},'owner_fixture');
  const next={...definition,version:2,fields:[...definition.fields,{id:'enabled',section:'general',label:'Enabled',type:'boolean',default:true}]};
  const migrated=storage.initialize(next);assert.deepEqual(migrated.values,{selected:[],frequency:70,enabled:true});assert.equal(migrated.revision,2);
  assert.equal(storage.initialize(next).revision,2);
  const incompatible={...next,version:3,fields:next.fields.map(field=>field.id==='frequency'?{...field,maximum:50}:field)};
  assert.throws(()=>storage.initialize(incompatible),/settings_invalid/);
  assert.deepEqual(storage.read(next).values,migrated.values);assert.equal(storage.read(next).revision,2);
});
