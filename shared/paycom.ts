export const paycomColumns = [
  ['inDay', 'Clock in'],
  ['outLunch', 'Lunch out'],
  ['inLunch', 'Lunch in'],
  ['outDay', 'Clock out'],
  ['totalHours', 'Hours'],
  ['condition', 'Punch status'],
] as const;
export type PaycomColumn = (typeof paycomColumns)[number][0];
export interface PaycomPreferences {
  automatic_sync: boolean;
  sync_interval_seconds: number;
  opening_page: 'timecards' | 'employees';
  rows_per_page: number;
  name_order: 'first_last' | 'last_first';
  default_sort: 'employeeName' | 'condition' | 'inDay';
  department: string | null;
  station: string | null;
  columns: PaycomColumn[];
  driver_departments: string[] | null;
}
export const paycomDefaults: PaycomPreferences = {
  automatic_sync: true,
  sync_interval_seconds: 3600,
  opening_page: 'timecards',
  rows_per_page: 100,
  name_order: 'first_last',
  default_sort: 'employeeName',
  department: null,
  station: null,
  columns: paycomColumns.map(([key]) => key),
  driver_departments: null,
};
export interface PaycomSettings {
  revision: number;
  values: PaycomPreferences;
  history: { revision: number; at: string; values: PaycomPreferences }[];
  options: { departments: { value: string; count: number }[]; stations: string[] };
}
export function employeeName(name: string, order: PaycomPreferences['name_order']) {
  const parts = name.trim().split(/\s+/);
  return order === 'last_first' && parts.length > 1
    ? `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`
    : name;
}
