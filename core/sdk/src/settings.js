"use strict";
const { boundedJson, plain, identifier, DispatchError } = require("./protocol");
const fail = (code = "settings_invalid") => {
  throw new DispatchError(code);
};
const own = (value, name) => Object.hasOwn(value, name);
function keys(value, allowed, required = []) {
  if (
    !plain(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !own(value, key))
  )
    fail();
}
function text(value, maximum = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    fail();
}
function fieldValue(value, field) {
  if (value === null && field.nullable === true) return null;
  if (field.type === "boolean") {
    if (typeof value !== "boolean") fail();
  } else if (field.type === "integer") {
    if (
      !Number.isSafeInteger(value) ||
      value < (field.minimum ?? 0) ||
      value > (field.maximum ?? 31536000)
    )
      fail();
  } else if (field.type === "string") {
    if (typeof value !== "string" || value.length > 128) fail();
  } else if (field.type === "strings") {
    if (
      !Array.isArray(value) ||
      value.length > (field.maxItems ?? 256) ||
      value.some((item) => typeof item !== "string" || item.length > 128) ||
      new Set(value).size !== value.length
    )
      fail();
  } else fail();
  if (field.options) {
    const options = new Set(field.options.map((item) => item.value));
    if (
      (field.type === "strings" ? value : [value]).some(
        (item) => !options.has(item),
      )
    )
      fail();
  }
  return structuredClone(value);
}
function validateSettingsDefinition(input) {
  const value = boundedJson(input, 32768);
  keys(
    value,
    [
      "version",
      "sections",
      "fields",
      "optionsView",
      "schedule",
      "migrations",
      "rules",
      "previews",
    ],
    ["version", "sections", "fields"],
  );
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Array.isArray(value.sections) ||
    !value.sections.length ||
    value.sections.length > 12 ||
    !Array.isArray(value.fields) ||
    !value.fields.length ||
    value.fields.length > 64
  )
    fail();
  const sections = new Set(),
    fields = new Map();
  for (const section of value.sections) {
    keys(section, ["id", "label", "description"], ["id", "label"]);
    identifier(section.id);
    text(section.label);
    if (section.description !== undefined) text(section.description, 500);
    if (sections.has(section.id)) fail();
    sections.add(section.id);
  }
  for (const field of value.fields) {
    keys(
      field,
      [
        "id",
        "label",
        "description",
        "section",
        "type",
        "default",
        "options",
        "optionsSource",
        "nullable",
        "ordered",
        "minimum",
        "maximum",
        "maxItems",
        "visibleWhen",
        "enabledWhen",
        "disabledReason",
        "applies",
      ],
      ["id", "label", "section", "type", "default"],
    );
    identifier(field.id);
    text(field.label);
    if (fields.has(field.id) || !sections.has(field.section)) fail();
    if (!["boolean", "integer", "string", "strings"].includes(field.type))
      fail();
    if (field.description !== undefined) text(field.description, 500);
    for (const key of ["nullable", "ordered"])
      if (own(field, key) && typeof field[key] !== "boolean") fail();
    for (const key of ["minimum", "maximum", "maxItems"])
      if (
        own(field, key) &&
        (!Number.isSafeInteger(field[key]) || field[key] < 0)
      )
        fail();
    if (
      field.maxItems > 256 ||
      field.minimum > field.maximum ||
      (field.ordered && field.type !== "strings")
    )
      fail();
    if (field.optionsSource !== undefined) identifier(field.optionsSource);
    if (
      field.optionsSource &&
      (!["string", "strings"].includes(field.type) || field.options)
    )
      fail();
    if (field.options !== undefined) {
      if (
        !Array.isArray(field.options) ||
        !field.options.length ||
        field.options.length > 256
      )
        fail();
      const seen = new Set();
      for (const option of field.options) {
        keys(option, ["label", "value"], ["label", "value"]);
        text(option.label);
        fieldValue(option.value, {
          ...field,
          type: field.type === "strings" ? "string" : field.type,
          options: undefined,
          nullable: false,
        });
        if (seen.has(option.value)) fail();
        seen.add(option.value);
      }
    }
    fieldValue(field.default, field);
    fields.set(field.id, field);
  }
  require("./settings-schema").validateBehavior(value, fields, fieldValue);
  if (value.optionsView !== undefined) identifier(value.optionsView);
  if (value.fields.some((field) => field.optionsSource) && !value.optionsView)
    fail();
  if (value.schedule) {
    keys(
      value.schedule,
      ["id", "enabled", "interval"],
      ["id", "enabled", "interval"],
    );
    identifier(value.schedule.id);
    if (
      fields.get(value.schedule.enabled)?.type !== "boolean" ||
      fields.get(value.schedule.interval)?.type !== "integer" ||
      fields.get(value.schedule.enabled).nullable ||
      fields.get(value.schedule.interval).nullable ||
      !(fields.get(value.schedule.interval).minimum >= 10) ||
      !(fields.get(value.schedule.interval).maximum <= 31536000)
    )
      fail();
  }
  if (value.migrations !== undefined) {
    if (!Array.isArray(value.migrations) || value.migrations.length > 64)
      fail();
    const seen = new Set();
    for (const migration of value.migrations) {
      keys(
        migration,
        [
          "fromVersion",
          "rename",
          "remove",
          "copy",
          "mapValues",
          "scale",
          "reset",
        ],
        ["fromVersion"],
      );
      if (
        !Number.isSafeInteger(migration.fromVersion) ||
        migration.fromVersion < 1 ||
        migration.fromVersion >= value.version ||
        seen.has(migration.fromVersion)
      )
        fail();
      seen.add(migration.fromVersion);
      if (migration.rename !== undefined) {
        if (!plain(migration.rename)) fail();
        for (const [from, to] of Object.entries(migration.rename)) {
          identifier(from);
          identifier(to);
        }
      }
      for (const name of ["copy", "mapValues", "scale"])
        if (migration[name] !== undefined) {
          if (
            !plain(migration[name]) ||
            Object.keys(migration[name]).length > 64
          )
            fail();
          for (const [field, input] of Object.entries(migration[name])) {
            identifier(field);
            if (name === "copy") {
              if (
                !Array.isArray(input) ||
                !input.length ||
                input.length > 64 ||
                new Set(input).size !== input.length ||
                input.includes(field)
              )
                fail();
              input.forEach(identifier);
            } else if (name === "scale") {
              if (
                typeof input !== "number" ||
                !Number.isFinite(input) ||
                input <= 0 ||
                input > 1e9
              )
                fail();
            } else {
              if (!Array.isArray(input) || !input.length || input.length > 256)
                fail();
              const seen = new Set();
              for (const mapping of input) {
                keys(mapping, ["from", "to"], ["from", "to"]);
                const key = JSON.stringify(mapping.from);
                if (seen.has(key)) fail();
                seen.add(key);
              }
            }
          }
        }
      if (migration.reset !== undefined) {
        if (
          !Array.isArray(migration.reset) ||
          migration.reset.length > 64 ||
          new Set(migration.reset).size !== migration.reset.length
        )
          fail();
        migration.reset.forEach(identifier);
      }
      if (migration.remove !== undefined) {
        if (!Array.isArray(migration.remove) || migration.remove.length > 64)
          fail();
        migration.remove.forEach(identifier);
      }
    }
  }
  return value;
}
function settingsValues(definition, input, { defaults = false } = {}) {
  const value = boundedJson(input, 32768);
  keys(
    value,
    definition.fields.map((field) => field.id),
    defaults ? [] : definition.fields.map((field) => field.id),
  );
  const result = Object.fromEntries(
    definition.fields.map((field) => [
      field.id,
      fieldValue(own(value, field.id) ? value[field.id] : field.default, field),
    ]),
  );
  if (
    require("./settings-behavior")
      .settingsIssues(definition, result)
      .some((issue) => issue.severity === "error")
  )
    fail();
  return result;
}
function settingsSources(definition, input, values) {
  keys(
    input,
    definition.fields.map((field) => field.id),
    definition.fields.map((field) => field.id),
  );
  return Object.fromEntries(
    definition.fields.map((field) => {
      const source = input[field.id];
      if (
        !["default", "override"].includes(source) ||
        (source === "default" &&
          values &&
          JSON.stringify(values[field.id]) !== JSON.stringify(field.default))
      )
        fail();
      return [field.id, source];
    }),
  );
}
function migrateSettingsState(definition, values, version, inputSources) {
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > definition.version
  )
    fail("settings_incompatible");
  const result = boundedJson(values, 32768),
    sources = inputSources
      ? boundedJson(inputSources, 32768)
      : Object.fromEntries(Object.keys(result).map((key) => [key, "override"]));
  if (
    Object.keys(sources).some((key) => !own(result, key)) ||
    Object.keys(result).some(
      (key) => !["default", "override"].includes(sources[key]),
    )
  )
    fail();
  const same = require("./settings-behavior").same;
  function transfer(old, next) {
    if (!own(result, old)) return;
    if (own(result, next)) fail("settings_migration_conflict");
    result[next] = structuredClone(result[old]);
    sources[next] = sources[old];
  }
  for (let from = version; from < definition.version; from++) {
    const migration = definition.migrations?.find(
      (item) => item.fromVersion === from,
    );
    for (const [old, next] of Object.entries(migration?.rename || {})) {
      transfer(old, next);
      delete result[old];
      delete sources[old];
    }
    for (const [old, targets] of Object.entries(migration?.copy || {}))
      for (const next of targets) transfer(old, next);
    for (const [field, mappings] of Object.entries(migration?.mapValues || {}))
      if (own(result, field)) {
        const map = (value) => {
          const match = mappings.find((item) => same(item.from, value));
          return match ? structuredClone(match.to) : value;
        };
        const mapped = map(result[field]);
        result[field] =
          mapped === result[field] && Array.isArray(mapped)
            ? mapped.map(map)
            : mapped;
      }
    for (const [field, factor] of Object.entries(migration?.scale || {}))
      if (own(result, field)) {
        if (typeof result[field] !== "number") fail();
        result[field] *= factor;
      }
    for (const field of [
      ...(migration?.remove || []),
      ...(migration?.reset || []),
    ]) {
      delete result[field];
      delete sources[field];
    }
  }
  for (const field of definition.fields)
    if (!own(result, field.id) || sources[field.id] === "default") {
      result[field.id] = structuredClone(field.default);
      sources[field.id] = "default";
    }
  const resolved = settingsValues(definition, result);
  return {
    values: resolved,
    sources: settingsSources(definition, sources, resolved),
  };
}
function migrateSettings(definition, values, version) {
  return migrateSettingsState(definition, values, version).values;
}
module.exports = {
  validateSettingsDefinition,
  settingsValues,
  settingsSources,
  migrateSettings,
  migrateSettingsState,
};
