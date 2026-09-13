"use strict";
const { plain, identifier, DispatchError } = require("./protocol");
function invalid() {
  throw new DispatchError("settings_invalid");
}
function keys(value, allowed, required = allowed) {
  if (
    !plain(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function text(value, limit = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    invalid();
}
function validateBehavior(definition, fields, fieldValue) {
  function condition(value) {
    keys(value, ["field", "equals"]);
    if (!fields.has(value.field)) invalid();
    fieldValue(value.equals, fields.get(value.field));
  }
  for (const field of fields.values()) {
    for (const key of ["visibleWhen", "enabledWhen"])
      if (field[key]) {
        condition(field[key]);
        if (field[key].field === field.id) invalid();
      }
    if (field.disabledReason !== undefined) {
      text(field.disabledReason);
      if (!field.enabledWhen) invalid();
    }
    if (
      field.applies !== undefined &&
      !["immediate", "next_job", "next_connection", "schedule"].includes(
        field.applies,
      )
    )
      invalid();
  }
  for (const key of ["rules", "previews"]) {
    if (definition[key] === undefined) continue;
    if (!Array.isArray(definition[key]) || definition[key].length > 32)
      invalid();
    const ids = new Set();
    for (const item of definition[key]) {
      identifier(item.id);
      if (ids.has(item.id)) invalid();
      ids.add(item.id);
      if (key === "rules") {
        keys(
          item,
          [
            "id",
            "kind",
            "when",
            "require",
            "field",
            "selection",
            "severity",
            "message",
          ],
          ["id", "kind", "severity", "message"],
        );
        text(item.message);
        if (!["warning", "error"].includes(item.severity)) invalid();
        if (item.when) condition(item.when);
        if (item.kind === "included") {
          if (
            item.require ||
            fields.get(item.field)?.type !== "string" ||
            fields.get(item.selection)?.type !== "strings"
          )
            invalid();
        } else if (item.kind === "requires") {
          condition(item.require);
          if (item.field || item.selection) invalid();
        } else invalid();
      } else {
        keys(
          item,
          [
            "id",
            "kind",
            "section",
            "label",
            "field",
            "examples",
            "leading",
            "unit",
            "groupLabel",
          ],
          ["id", "kind", "section", "label", "field"],
        );
        identifier(item.field);
        text(item.label, 160);
        if (!definition.sections.some((section) => section.id === item.section))
          invalid();
        const field = fields.get(item.field);
        if (!field) invalid();
        if (item.kind === "choice") {
          if (
            !Array.isArray(item.examples) ||
            !item.examples.length ||
            item.examples.length > 256 ||
            item.leading ||
            item.unit ||
            item.groupLabel
          )
            invalid();
          const seen = new Set();
          for (const example of item.examples) {
            keys(example, ["value", "text"]);
            fieldValue(example.value, field);
            text(example.text);
            const key = JSON.stringify(example.value);
            if (seen.has(key)) invalid();
            seen.add(key);
          }
        } else if (item.kind === "columns") {
          if (
            field.type !== "strings" ||
            !field.options ||
            item.examples ||
            item.unit ||
            item.groupLabel
          )
            invalid();
          if (item.leading !== undefined) text(item.leading, 160);
        } else if (item.kind === "selection_count") {
          if (
            field.type !== "strings" ||
            !field.optionsSource ||
            item.examples ||
            item.leading
          )
            invalid();
          text(item.unit, 80);
          text(item.groupLabel, 80);
        } else invalid();
      }
    }
  }
}
module.exports = { validateBehavior };
