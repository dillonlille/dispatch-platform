"use strict";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function conditionMatches(condition, values) {
  return !condition || same(values[condition.field], condition.equals);
}
function settingsIssues(definition, values) {
  return (definition.rules || [])
    .filter((rule) => {
      if (!conditionMatches(rule.when, values)) return false;
      if (rule.kind === "included") {
        const selected = values[rule.selection],
          value = values[rule.field];
        return value !== null && selected !== null && !selected.includes(value);
      }
      return !conditionMatches(rule.require, values);
    })
    .map((rule) => ({
      id: rule.id,
      field: rule.field || rule.require.field,
      severity: rule.severity,
      message: rule.message,
    }));
}
function formatSettingValue(field, value, options = {}) {
  if (value === undefined) return "Not recorded";
  if (value === null) return "All current and future options";
  if (typeof value === "boolean") return value ? "On" : "Off";
  const choices = field.options || options[field.optionsSource] || [];
  const label = (item) =>
    choices.find((option) => option.value === item)?.label || String(item);
  return Array.isArray(value)
    ? value.length
      ? value.map(label).join(", ")
      : "None"
    : label(value);
}
function settingsPreview(preview, values, fields, options = {}) {
  const field = fields.find((item) => item.id === preview.field);
  if (preview.kind === "choice")
    return (
      preview.examples.find((item) => same(item.value, values[field.id]))
        ?.text || ""
    );
  if (preview.kind === "columns")
    return [
      preview.leading,
      ...(values[field.id] || []).map(
        (value) =>
          (field.options || []).find((item) => item.value === value)?.label ||
          value,
      ),
    ]
      .filter(Boolean)
      .join(" · ");
  const choices = options[field.optionsSource] || [],
    selected = values[field.id];
  const included =
    selected === null
      ? choices
      : choices.filter((item) => selected.includes(item.value));
  const count = included.reduce((sum, item) => sum + (item.count || 0), 0);
  return `${count} ${preview.unit} from ${included.length} ${preview.groupLabel}.`;
}
const EFFECTS = Object.freeze({
  immediate: "Display changes take effect after saving.",
  next_job:
    "Collection changes apply to new jobs. Running jobs keep their current settings.",
  next_connection:
    "Changes apply to the next connection. An active connection keeps its current settings.",
  schedule:
    "The schedule is updated after saving. Running collections are allowed to finish.",
});
module.exports = {
  same,
  conditionMatches,
  settingsIssues,
  formatSettingValue,
  settingsPreview,
  EFFECTS,
};
