import type { Input, SettingsDefinition, SettingsSources } from "./index";
export function validateSettingsDefinition(input: unknown): SettingsDefinition;
export function settingsValues(
  definition: SettingsDefinition,
  input: Input,
  options?: { defaults?: boolean },
): Input;
export function settingsSources(
  definition: SettingsDefinition,
  input: SettingsSources,
  values?: Input,
): SettingsSources;
export function migrateSettings(
  definition: SettingsDefinition,
  values: Input,
  version: number,
): Input;
export function migrateSettingsState(
  definition: SettingsDefinition,
  values: Input,
  version: number,
  sources?: SettingsSources,
): { values: Input; sources: SettingsSources };
