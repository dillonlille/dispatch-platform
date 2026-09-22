import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { allTests } from '../ci/test-plan.js';

const result = spawnSync(
  process.execPath,
  [
    'node_modules/tsx/dist/cli.mjs',
    '--test',
    // Every test file owns its servers, ports, state and mail, so files run in parallel.
    `--test-concurrency=${os.availableParallelism()}`,
    ...process.argv.slice(2),
    ...allTests(),
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
