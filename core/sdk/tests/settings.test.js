"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  validateSettingsDefinition,
  settingsValues,
  migrateSettingsState,
} = require("../src/settings");
const {
  conditionMatches,
  settingsIssues,
  settingsPreview,
} = require("../src/settings-behavior");
const field = (id, type, defaultValue) => ({
  id,
  type,
  default: defaultValue,
  label: id,
  section: "general",
});
const definition = {
  version: 1,
  sections: [{ id: "general", label: "General" }],
  fields: [
    field("enabled", "boolean", true),
    {
      ...field("interval", "integer", 30),
      minimum: 10,
      maximum: 100,
      enabledWhen: { field: "enabled", equals: true },
      disabledReason: "Enable automatic work.",
    },
    field("department", "string", null),
    field("selected", "strings", null),
  ].map((f) => (f.default === null ? { ...f, nullable: true } : f)),
  rules: [
    {
      id: "included",
      kind: "included",
      field: "department",
      selection: "selected",
      severity: "warning",
      message: "The department is excluded.",
    },
  ],
};
test("conditional settings retain disabled values and cross-field rules run on the server", () => {
  const d = validateSettingsDefinition(definition),
    v = settingsValues(d, {
      enabled: false,
      interval: 80,
      department: "D1",
      selected: [],
    });
  assert.equal(conditionMatches(d.fields[1].enabledWhen, v), false);
  assert.equal(v.interval, 80);
  assert.equal(settingsIssues(d, v)[0].severity, "warning");
  const strict = validateSettingsDefinition({
    ...d,
    rules: [
      {
        id: "dependent",
        kind: "requires",
        when: { field: "enabled", equals: true },
        require: { field: "selected", equals: null },
        severity: "error",
        message: "Choose all groups.",
      },
    ],
  });
  assert.throws(
    () => settingsValues(strict, { ...v, enabled: true }),
    /settings_invalid/,
  );
  assert.throws(
    () =>
      validateSettingsDefinition({
        ...d,
        fields: d.fields.map((f) =>
          f.id === "interval"
            ? { ...f, visibleWhen: { field: "missing", equals: true } }
            : f,
        ),
      }),
    /settings_invalid/,
  );
  assert.throws(
    () => settingsValues(d, { ...v, interval: 999 }),
    /settings_invalid/,
  );
});
test("bounded migrations rename, split, map options, convert units and deliberately reset one field", () => {
  const d = validateSettingsDefinition({
    version: 3,
    sections: definition.sections,
    fields: [
      field("left", "string", "new"),
      field("right", "string", "new"),
      { ...field("seconds", "integer", 60), maximum: 10000 },
      field("reset_me", "boolean", true),
      field("groups", "strings", []),
    ],
    migrations: [
      {
        fromVersion: 1,
        rename: { mode: "choice" },
        copy: { choice: ["left", "right"] },
        mapValues: {
          left: [{ from: "old", to: "new" }],
          right: [{ from: "old", to: "new" }],
          groups: [{ from: "old-id", to: "new-id" }],
        },
        scale: { seconds: 60 },
        remove: ["choice"],
      },
      { fromVersion: 2, reset: ["reset_me"] },
    ],
  });
  const state = migrateSettingsState(
    d,
    { mode: "old", seconds: 2, reset_me: false, groups: ["old-id", "keep"] },
    1,
  );
  assert.deepEqual(state.values, {
    left: "new",
    right: "new",
    seconds: 120,
    reset_me: true,
    groups: ["new-id", "keep"],
  });
  assert.equal(state.sources.reset_me, "default");
  assert.equal(state.sources.left, "override");
  assert.throws(
    () =>
      migrateSettingsState(
        d,
        {
          mode: "old",
          left: "occupied",
          seconds: 2,
          reset_me: false,
          groups: [],
        },
        1,
      ),
    /settings_migration_conflict/,
  );
  assert.throws(
    () =>
      migrateSettingsState(
        d,
        {
          mode: "old",
          seconds: 2,
          reset_me: false,
          groups: [],
          undeclared: true,
        },
        1,
      ),
    /settings_invalid/,
  );
});
test("shared previews use plugin declarations and current DSP option counts", () => {
  const d = require("../../tests/fixtures/paycom-plugin.json").settings,
    v = settingsValues(d, {}, { defaults: true });
  assert.equal(settingsPreview(d.previews[0], v, d.fields), "JANE DOE");
  const p = d.previews.find((p) => p.kind === "selection_count");
  assert.equal(
    settingsPreview(p, { ...v, driver_departments: ["D2"] }, d.fields, {
      departments: [
        { value: "D1", label: "One", count: 100 },
        { value: "D2", label: "Two", count: 7 },
      ],
    }),
    "7 employees from 1 departments.",
  );
  assert.equal(
    settingsPreview(p, { ...v, driver_departments: [] }, d.fields, {
      departments: [{ value: "D2", label: "Two", count: 7 }],
    }),
    "0 employees from 0 departments.",
  );
});
