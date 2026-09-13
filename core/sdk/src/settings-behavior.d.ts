import type {
  Input,
  Json,
  SettingsCondition,
  SettingsDefinition,
  SettingsField,
  SettingsOption,
  SettingsPreview,
  SettingsTiming,
} from "../types/index";
export function same(a: unknown, b: unknown): boolean;
export function conditionMatches(
  condition: SettingsCondition | undefined,
  values: Input,
): boolean;
export function settingsIssues(
  definition: SettingsDefinition,
  values: Input,
): {
  id: string;
  field: string;
  severity: "warning" | "error";
  message: string;
}[];
export function formatSettingValue(
  field: SettingsField,
  value: Json | undefined,
  options?: Record<string, SettingsOption[]>,
): string;
export function settingsPreview(
  preview: SettingsPreview,
  values: Input,
  fields: SettingsField[],
  options?: Record<string, SettingsOption[]>,
): string;
export const EFFECTS: Record<SettingsTiming, string>;
