"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { openDatabase } = require("dispatch-protocol/published/database");
const { schema, publishPeriod } = require("../adapters/published");
const { PublishedWorkforcePort } = require("../../dashboard/published");
const {
  WorkforceClient,
} = require("dispatch-protocol/contracts/src/workforce-client");
const { workforceFixture } = require("./published-fixture");
test("selected DSP driver departments filter Timecards before pagination and summaries while retaining the full directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paycom-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "published/paycom.sqlite3"),
    db = openDatabase(file, { write: true, journalMode: "DELETE" });
  schema(db);
  const raw = workforceFixture({ count: 103 });
  raw.roster.employees.forEach((row, index) => {
    row.departmentCode = index < 101 ? "D1" : "D2";
    row.departmentDesc = index < 101 ? "Dispatch" : "Driver";
    row.deliveryStationCode = "S1";
    row.deliveryStationDesc = "North";
  });
  publishPeriod(db, raw, "America/Chicago");
  db.close();
  const a = new WorkforceClient({
    port: new PublishedWorkforcePort(file, { driver_departments: ["D2"] }),
  });
  const b = new WorkforceClient({
    port: new PublishedWorkforcePort(file, { driver_departments: null }),
  });
  const query = {
    date: "2026-09-11",
    limit: 1,
    offset: 1,
    sort: "employeeName",
    direction: "desc",
  };
  const selected = await a.day(query),
    all = await b.day(query);
  assert.equal(selected.ok, true);
  assert.equal(selected.data.total, 2);
  assert.equal(selected.data.items.length, 1);
  assert.equal(selected.data.hasMore, false);
  assert.equal(selected.data.summary.employees, 2);
  assert.equal(all.data.total, 103);
  assert.equal((await a.employees({})).data.total, 103);
  const none = new WorkforceClient({
    port: new PublishedWorkforcePort(file, { driver_departments: [] }),
  });
  const empty = await none.day({ date: "2026-09-11" });
  assert.equal(empty.data.total, 0);
  assert.equal(empty.data.available, true);
  assert.equal(empty.data.summary.employees, 0);
  const options = new PublishedWorkforcePort(file).settingsOptions();
  assert.equal(
    options.departments.find((item) => item.value === "D2").count,
    2,
  );
  assert.equal((await a.day({ ...query, department: "D1" })).data.total, 0);
});

test("name order preserves Paycom spelling, compound names and suffixes without guessing ambiguous names", () => {
  const { displayEmployeeName } = require("../../dashboard/published");
  for (const [source, first] of [
    ["DOE, JANE", "JANE DOE"],
    ["DE LA CRUZ, MARÍA ELENA", "MARÍA ELENA DE LA CRUZ"],
    ["SMITH JR, JOHN", "JOHN SMITH JR"],
    ["O’NEILL-SMITH, ANNE-MARIE", "ANNE-MARIE O’NEILL-SMITH"],
    ["PRINCE", "PRINCE"],
    ["DOE, JR., JOHN", "DOE, JR., JOHN"],
    ["DOE, ", "DOE, "],
  ]) {
    assert.equal(displayEmployeeName(source, "first_last"), first);
    assert.equal(displayEmployeeName(source, "last_first"), source);
    assert.equal(displayEmployeeName(source), source);
  }
});

test("DSP name order changes displayed records and sorts before pagination while preserving source data and sibling views", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paycom-name-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "published/paycom.sqlite3");
  const db = openDatabase(file, { write: true, journalMode: "DELETE" });
  schema(db);
  const raw = workforceFixture({ count: 103 });
  raw.roster.employees.forEach((employee, i) => {
    employee.employeeName = `SURNAME ${String(i).padStart(3, "0")}, GIVEN ${String(102 - i).padStart(3, "0")}`;
    raw.timecards.rows[i].employeeName = employee.employeeName;
  });
  publishPeriod(db, raw, "America/Chicago");
  db.close();
  const bytes = fs.readFileSync(file);
  const first = new WorkforceClient({
    port: new PublishedWorkforcePort(file, { name_order: "first_last" }),
  });
  const last = new WorkforceClient({
    port: new PublishedWorkforcePort(file, { name_order: "last_first" }),
  });
  const query = {
    date: "2026-09-11",
    sort: "employeeName",
    direction: "asc",
    limit: 2,
    offset: 100,
  };
  const a = await first.day(query),
    b = await last.day(query);
  assert(a.ok);
  assert(b.ok);
  assert.equal(a.data.total, 103);
  assert.equal(a.data.summary.employees, 103);
  assert.deepEqual(
    a.data.items.map((row) => row.employeeName),
    ["GIVEN 100 SURNAME 002", "GIVEN 101 SURNAME 001"],
  );
  assert.deepEqual(
    b.data.items.map((row) => row.employeeName),
    ["SURNAME 100, GIVEN 002", "SURNAME 101, GIVEN 001"],
  );
  assert.equal(
    (await first.day({ ...query, direction: "desc", offset: 0, limit: 1 })).data
      .items[0].employeeName,
    "GIVEN 102 SURNAME 000",
  );
  const search = await first.day({
    ...query,
    offset: 0,
    search: "given 100 surname 002",
  });
  assert.equal(search.data.total, 1);
  assert.equal(
    (await first.day({ ...query, offset: 0, search: "surname 002, given 100" }))
      .data.total,
    1,
  );
  const employees = await first.employees({ limit: 100 });
  assert(employees.ok);
  assert.equal(employees.data.total, 103);
  const record = employees.data.items.find(
    (row) => row.employeeCode === "0000",
  );
  assert.equal(record.employeeName, "GIVEN 102 SURNAME 000");
  const detail = await first.employee("0000");
  assert(detail.ok);
  assert.equal(detail.data.employee.employeeName, record.employeeName);
  assert.equal(detail.data.timecard.employeeName, record.employeeName);
  const portDetail = new PublishedWorkforcePort(file, {
    name_order: "first_last",
  }).employee("0000");
  assert(
    portDetail.days.every((row) => row.employeeName === record.employeeName),
  );
  assert.equal(
    (await last.employee("0000")).data.employee.employeeName,
    "SURNAME 000, GIVEN 102",
  );
  assert.deepEqual(fs.readFileSync(file), bytes);
});

for (const oldVersion of [1, 2, 3])
  test(`SDK migration sets First Last once from definition ${oldVersion}, preserving other DSP preferences`, (t) => {
    const {
      settingsStore,
    } = require("dispatch-core/core/plugins/settings-store.js");
    const definition = require("../../dispatch-plugin.json").settings;
    const { migrations, previews, ...base } = definition;
    const old = {
      ...base,
      version: oldVersion,
      fields: definition.fields
        .filter((field) => oldVersion !== 1 || field.id !== "name_order")
        .map((field) =>
          field.id === "name_order"
            ? {
                ...field,
                default: oldVersion === 3 ? "first_last" : "last_first",
              }
            : field,
        ),
    };
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "paycom-name-migration-"),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const storage = settingsStore(root, "paycom");
    const before = storage.initialize(old, {
      automatic_sync: false,
      sync_interval_seconds: 7200,
      driver_departments: ["D2"],
      rows_per_page: 25,
      columns: ["totalHours", "inDay"],
    });
    const migrated = storage.initialize(definition);
    assert.equal(migrated.definitionVersion, 4);
    assert.equal(migrated.revision, before.revision + 1);
    assert.deepEqual(migrated.values, {
      ...before.values,
      name_order: "first_last",
    });
    const saved = storage.update(
      definition,
      {
        values: { ...migrated.values, name_order: "last_first" },
        expectedRevision: migrated.revision,
        definitionVersion: 4,
        idempotencyKey: "test:name-order",
      },
      "owner:test",
    );
    const restarted = settingsStore(root, "paycom").initialize(definition);
    assert.deepEqual(restarted, saved);
    assert.equal(saved.values.automatic_sync, false);
    assert.deepEqual(saved.values.driver_departments, ["D2"]);
    assert.throws(
      () =>
        storage.update(
          definition,
          {
            values: { ...saved.values, name_order: "invalid" },
            expectedRevision: saved.revision,
            definitionVersion: 4,
            idempotencyKey: "test:invalid-order",
          },
          "owner:test",
        ),
      { code: "settings_invalid" },
    );
    const sibling = settingsStore(
      path.join(root, "sibling"),
      "paycom",
    ).initialize(definition);
    assert.equal(sibling.values.name_order, "first_last");
    const { settingsValues } = require("dispatch-sdk/settings");
    assert.equal(
      settingsValues(definition, {}, { defaults: true }).name_order,
      "first_last",
    );
  });
