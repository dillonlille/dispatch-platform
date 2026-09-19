import fs from 'node:fs';

// Which check runs which `tests/*.test.ts` file. `test-plan.json` is the only list:
// `ci-plan.py` reads `dashboard` to scope a change and `browseros-check.py` reads `native`.
const plan = JSON.parse(fs.readFileSync(new URL('./test-plan.json', import.meta.url), 'utf8')) as {
  dashboard: string[];
  native: Record<string, string[]>;
};

/** Dashboard logic: the build check runs these in every mode, dashboard-only changes included. */
export const dashboardTests = plan.dashboard;
/** Native collector shards, run with a real browser by `npm run test:browseros`. */
export const nativeShards = plan.native;
/** Every other test file: the core check runs these, so nothing runs twice in full validation. */
export function coreTests(directory = 'tests') {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `${directory}/${name}`)
    .filter((file) => !dashboardTests.includes(file));
}
