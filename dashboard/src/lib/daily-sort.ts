import type { DailyTimecard } from '../../../shared/contracts/index.js';
const collator = new Intl.Collator('en');
function value(row: DailyTimecard, key: string): string | number {
  switch (key) {
    case 'hours':
    case 'totalHours':
      return row.hours;
    case 'condition':
      return row.status;
    case 'inDay':
      return row.punches[0]?.in ?? '';
    case 'outDay':
      return row.punches.at(-1)?.out ?? '';
    case 'outLunch':
      return row.punches.length > 1 ? (row.punches[0]?.out ?? '') : '';
    case 'inLunch':
      return row.punches.length > 1 ? (row.punches[1]?.in ?? '') : '';
    default:
      return row.name;
  }
}
/** Match the API's primary ordering and ascending employee-code tie breaker. */
export function sortDailyRows(rows: DailyTimecard[], key: string, descending: boolean) {
  return [...rows].sort((a, b) => {
    const x = value(a, key),
      y = value(b, key);
    const order =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : collator.compare(String(x), String(y));
    return (descending ? -order : order) || collator.compare(a.employeeCode, b.employeeCode);
  });
}
