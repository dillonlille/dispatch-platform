export const paycomColumns = [
  ['inDay', 'Clock in'],
  ['outLunch', 'Lunch out'],
  ['inLunch', 'Lunch in'],
  ['outDay', 'Clock out'],
  ['totalHours', 'Hours'],
  ['condition', 'Punch status'],
] as const;
export type PaycomColumn = (typeof paycomColumns)[number][0];
// The backend stores and validates more keys than the dashboard reads; the
// settings editor sends back every value it received, so they stay intact.
export interface PaycomPreferences {
  name_order: 'first_last' | 'last_first';
  driver_departments: string[] | null;
  late_da_time: string;
  late_da_departments: string[];
}
export const paycomDefaults: PaycomPreferences = {
  name_order: 'first_last',
  driver_departments: null,
  late_da_time: '10:01',
  late_da_departments: [],
};
export interface PaycomSettings {
  revision: number;
  values: PaycomPreferences;
  options: { departments: { value: string; count: number }[] };
}
export function employeeName(name: string, order: PaycomPreferences['name_order']) {
  const parts = name.trim().split(/\s+/);
  return order === 'last_first' && parts.length > 1
    ? `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`
    : name;
}
