import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { MealComparison, MealSource, LateRule } from '../../shared/contracts/meals.js';
import type { EmployeeTimecard, Timecard } from '../../shared/contracts/workforce.js';

export type MealComparisonSource = Omit<MealComparison, 'rows' | 'date'> & {
  date: string | null;
  rows: MealSource[];
};
let executable: string | undefined;
function assess(input: {
  date: string;
  late?: LateRule;
  rows?: MealSource[];
  timecards?: Timecard[];
}): { rows: MealComparison['rows']; timecards: EmployeeTimecard[] } {
  if (!executable) {
    // test:ui builds this test-only companion before starting browser workers.
    const metadata = JSON.parse(
      execFileSync('cargo', ['metadata', '--no-deps', '--format-version=1', '--locked'], {
        encoding: 'utf8',
      }),
    );
    executable = path.join(metadata.target_directory, 'debug/examples/assessment-fixture');
  }
  return JSON.parse(
    execFileSync(executable!, {
      input: JSON.stringify([input]),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  )[0];
}
export function assessMealResponse(
  source: MealComparisonSource,
  late: LateRule = { time: '10:01', departments: [] },
): MealComparison {
  if (!source.date) throw new Error('Meal fixtures need a date');
  return {
    ...source,
    date: source.date,
    rows: assess({ date: source.date, late, rows: source.rows }).rows,
  };
}
export function assessTimecards(cards: Timecard[]): EmployeeTimecard[] {
  return assess({ date: '2026-09-15', timecards: cards }).timecards;
}
