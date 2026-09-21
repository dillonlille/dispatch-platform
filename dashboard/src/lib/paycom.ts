import type { PaycomPreferences } from '../../../shared/contracts/paycom.js';
export const paycomColumns = [
  ['inDay', 'Clock in'],
  ['outLunch', 'Lunch out'],
  ['inLunch', 'Lunch in'],
  ['outDay', 'Clock out'],
  ['totalHours', 'Hours'],
  ['condition', 'Punch status'],
] as const;
export type PaycomColumn = (typeof paycomColumns)[number][0];
export const paycomDefaults: PaycomPreferences = {
  name_order: 'first_last',
  driver_departments: null,
  late_da_time: '10:01',
  late_da_departments: [],
};
export function employeeName(name: string, order: PaycomPreferences['name_order']) {
  const parts = name.trim().split(/\s+/);
  return order === 'last_first' && parts.length > 1
    ? `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`
    : name;
}
