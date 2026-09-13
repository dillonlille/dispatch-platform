"use strict";
const path = require("node:path"),
  crypto = require("node:crypto");
const {
  openDatabase,
  transaction,
} = require("../../shared/published/database");
const { privateDirectory } = require("../../host/controller/operations");
const {
  identifier,
  exact,
  key,
  DispatchError,
} = require("../../sdk/src/protocol");
const {
  validateSettingsDefinition,
  settingsValues,
  settingsSources,
  migrateSettingsState,
} = require("../../sdk/src/settings");
const { same } = require("../../sdk/src/settings-behavior");
const fail = (code) => {
  throw new DispatchError(code);
};
function settingsStore(dspRoot, pluginId) {
  identifier(pluginId);
  const directory = path.join(dspRoot, "config/plugins", pluginId),
    file = path.join(directory, "settings.sqlite3");
  function open(write) {
    if (write) privateDirectory(directory);
    const db = openDatabase(file, { write, journalMode: "DELETE" });
    if (write) {
      db.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,revision INTEGER NOT NULL,values_json TEXT NOT NULL,updated_at INTEGER NOT NULL,actor TEXT,applied_revision INTEGER NOT NULL DEFAULT -1);
        CREATE TABLE IF NOT EXISTS history(revision INTEGER PRIMARY KEY,version INTEGER NOT NULL,values_json TEXT NOT NULL,updated_at INTEGER NOT NULL,actor TEXT);
        CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,digest TEXT NOT NULL,revision INTEGER NOT NULL);`);
      transaction(db, () => {
        for (const [table, columns] of [
          ["settings", ["sources_json"]],
          ["history", ["sources_json", "fields_json"]],
        ]) {
          const existing = new Set(
            db
              .prepare(`PRAGMA table_info(${table})`)
              .all()
              .map((row) => row.name),
          );
          for (const column of columns)
            if (!existing.has(column))
              db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        }
      });
    }
    return db;
  }
  function sources(row) {
    // Historical complete-value saves contain no per-field intent. Preserve all
    // of them as overrides, even values that happen to equal today's defaults.
    return row.sources_json
      ? JSON.parse(row.sources_json)
      : Object.fromEntries(
          Object.keys(JSON.parse(row.values_json)).map((key) => [
            key,
            "override",
          ]),
        );
  }
  function snapshot(row, definition) {
    if (!row || row.version !== definition.version)
      fail("settings_migration_required");
    const values = settingsValues(definition, JSON.parse(row.values_json));
    return {
      revision: row.revision,
      definitionVersion: row.version,
      values,
      sources: settingsSources(definition, sources(row), values),
      appliedRevision: row.applied_revision,
      updatedAt: row.updated_at,
      updatedBy: row.actor,
      definition,
    };
  }
  function persist(db, definition, state, revision, actor) {
    const timestamp = Date.now(),
      json = JSON.stringify(state.values),
      sourceJson = JSON.stringify(state.sources);
    db.prepare(
      `INSERT INTO settings(id,version,revision,values_json,updated_at,actor,sources_json) VALUES(1,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,revision=excluded.revision,values_json=excluded.values_json,updated_at=excluded.updated_at,actor=excluded.actor,sources_json=excluded.sources_json`,
    ).run(definition.version, revision, json, timestamp, actor, sourceJson);
    db.prepare(
      "INSERT INTO history(revision,version,values_json,updated_at,actor,sources_json,fields_json) VALUES(?,?,?,?,?,?,?)",
    ).run(
      revision,
      definition.version,
      json,
      timestamp,
      actor,
      sourceJson,
      JSON.stringify(
        definition.fields.map(({ id, label, section }) => ({
          id,
          label,
          section,
        })),
      ),
    );
  }
  return {
    pending() {
      const db = open(false);
      if (!db) return false;
      try {
        return !!db
          .prepare("SELECT 1 FROM settings WHERE revision<>applied_revision")
          .get();
      } finally {
        db.close();
      }
    },
    initialize(input, seed = {}) {
      const definition = validateSettingsDefinition(input),
        db = open(true);
      try {
        return transaction(db, () => {
          const before = db.prepare("SELECT * FROM settings WHERE id=1").get();
          if (!before) {
            const values = settingsValues(definition, seed, { defaults: true });
            persist(
              db,
              definition,
              {
                values,
                sources: Object.fromEntries(
                  definition.fields.map((field) => [
                    field.id,
                    Object.hasOwn(seed, field.id) ? "override" : "default",
                  ]),
                ),
              },
              0,
              null,
            );
          } else if (before.version !== definition.version) {
            persist(
              db,
              definition,
              migrateSettingsState(
                definition,
                JSON.parse(before.values_json),
                before.version,
                sources(before),
              ),
              before.revision + 1,
              null,
            );
          } else if (!before.sources_json) {
            // Record conservative provenance without changing values or revision.
            const encoded = JSON.stringify(sources(before));
            db.prepare("UPDATE settings SET sources_json=? WHERE id=1").run(
              encoded,
            );
            db.prepare(
              "UPDATE history SET sources_json=? WHERE revision=?",
            ).run(encoded, before.revision);
          }
          return snapshot(
            db.prepare("SELECT * FROM settings WHERE id=1").get(),
            definition,
          );
        });
      } finally {
        db.close();
      }
    },
    read(input) {
      const definition = validateSettingsDefinition(input),
        db = open(false);
      if (!db) fail("settings_not_initialized");
      try {
        return snapshot(
          db.prepare("SELECT * FROM settings WHERE id=1").get(),
          definition,
        );
      } finally {
        db.close();
      }
    },
    update(input, request, actor) {
      const definition = validateSettingsDefinition(input);
      exact(request, [
        "values",
        "expectedRevision",
        "definitionVersion",
        "idempotencyKey",
        ...(Object.hasOwn(request, "sources") ? ["sources"] : []),
      ]);
      key(request.idempotencyKey);
      key(actor);
      if (
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision < 0 ||
        request.definitionVersion !== definition.version
      )
        fail("settings_revision_conflict");
      const values = settingsValues(definition, request.values);
      const requestedSources =
        request.sources === undefined
          ? undefined
          : settingsSources(definition, request.sources, values);
      // Preserve legacy receipt digests and retries from an already open client.
      const digest = crypto
        .createHash("sha256")
        .update(
          JSON.stringify([
            actor,
            request.expectedRevision,
            request.definitionVersion,
            values,
            ...(requestedSources ? [requestedSources] : []),
          ]),
        )
        .digest("hex");
      const db = open(true);
      try {
        return transaction(db, () => {
          const before = db.prepare("SELECT * FROM settings WHERE id=1").get(),
            current = snapshot(before, definition);
          const existing = db
            .prepare("SELECT * FROM requests WHERE key=?")
            .get(request.idempotencyKey);
          if (existing) {
            if (existing.digest !== digest) fail("idempotency_conflict");
            return current;
          }
          if (before.revision !== request.expectedRevision)
            fail("settings_revision_conflict");
          if (db.prepare("SELECT count(*) n FROM requests").get().n >= 10000)
            fail("settings_request_capacity");
          const resolvedSources =
            requestedSources ||
            Object.fromEntries(
              definition.fields.map((field) => [
                field.id,
                same(values[field.id], current.values[field.id])
                  ? current.sources[field.id]
                  : "override",
              ]),
            );
          persist(
            db,
            definition,
            { values, sources: resolvedSources },
            before.revision + 1,
            actor,
          );
          db.prepare("INSERT INTO requests VALUES(?,?,?)").run(
            request.idempotencyKey,
            digest,
            before.revision + 1,
          );
          return snapshot(
            db.prepare("SELECT * FROM settings WHERE id=1").get(),
            definition,
          );
        });
      } finally {
        db.close();
      }
    },
    history(input, { beforeRevision = null } = {}) {
      const definition = validateSettingsDefinition(input);
      if (
        beforeRevision !== null &&
        (!Number.isSafeInteger(beforeRevision) || beforeRevision < 0)
      )
        fail("settings_invalid");
      const db = open(false);
      if (!db) fail("settings_not_initialized");
      try {
        const current = snapshot(
          db.prepare("SELECT * FROM settings WHERE id=1").get(),
          definition,
        );
        const rows = db
          .prepare(
            "SELECT * FROM history WHERE revision<? ORDER BY revision DESC LIMIT 11",
          )
          .all(beforeRevision ?? Number.MAX_SAFE_INTEGER);
        const items = [];
        let bytes = 0,
          nodes = 0;
        const countNodes = (value) =>
          value && typeof value === "object"
            ? 1 +
              Object.values(value).reduce(
                (sum, item) => sum + countNodes(item),
                0,
              )
            : 1;
        const preview = (value) =>
          Array.isArray(value) && value.length > 12
            ? [...value.slice(0, 12), "…"]
            : value;
        for (const row of rows.slice(0, 10)) {
          const values = JSON.parse(row.values_json),
            source = sources(row),
            previous = db
              .prepare(
                "SELECT * FROM history WHERE revision<? ORDER BY revision DESC LIMIT 1",
              )
              .get(row.revision);
          const prior = previous ? JSON.parse(previous.values_json) : {},
            priorSources = previous ? sources(previous) : {};
          const fields = row.fields_json
            ? JSON.parse(row.fields_json)
            : definition.fields;
          const ids = [
            ...new Set([...Object.keys(values), ...Object.keys(prior)]),
          ];
          const changes = ids
            .filter(
              (id) =>
                !same(values[id], prior[id]) || source[id] !== priorSources[id],
            )
            .map((id) => ({
              field: id,
              label: fields.find((field) => field.id === id)?.label || id,
              before: preview(prior[id] ?? null),
              after: preview(values[id] ?? null),
              beforeSource: priorSources[id] || null,
              afterSource: source[id] || null,
            }));
          const item = {
            revision: row.revision,
            definitionVersion: row.version,
            values,
            sources: source,
            updatedAt: row.updated_at,
            updatedBy: row.actor,
            kind: row.actor
              ? "owner"
              : row.revision === 0
                ? "initial"
                : "migration",
            changes,
            canRestore: row.version === definition.version,
          };
          const size = Buffer.byteLength(JSON.stringify(item));
          const nodeCount = countNodes(item);
          if (
            items.length &&
            (bytes + size > 180000 || nodes + nodeCount > 16000)
          )
            break;
          nodes += nodeCount;
          bytes += size;
          items.push(item);
        }
        return {
          items,
          nextBefore:
            rows.length > items.length
              ? (items.at(-1)?.revision ?? null)
              : null,
          currentRevision: current.revision,
        };
      } finally {
        db.close();
      }
    },
    applied(revision) {
      const db = open(true);
      try {
        db.prepare(
          "UPDATE settings SET applied_revision=? WHERE id=1 AND revision=?",
        ).run(revision, revision);
      } finally {
        db.close();
      }
    },
  };
}
module.exports = { settingsStore };
