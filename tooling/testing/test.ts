import { spawnSync } from 'node:child_process';
import { allTests } from '../ci/test-plan.js';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/tsx/dist/cli.mjs',
    '--test',
    '--test-concurrency=1',
    ...process.argv.slice(2),
    ...allTests(),
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
