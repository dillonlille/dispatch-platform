import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test(
  'archived Paycom browser regressions use native input and locally intercepted provider pages',
  {
    skip: process.env.DISPATCH_TEST_NATIVE !== '1',
    timeout: 180000,
  },
  async () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DISPATCH_CHROME_EXECUTABLE: '/opt/google/chrome/chrome',
    };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        ...[
          'session-start',
          'readiness',
          'assistance-continuation',
          'native-window',
          'session-persistence',
        ].map((name) => `tests/archived-paycom/paycom-${name}.test.js`),
      ],
      {
        stdio: 'inherit',
        env: environment,
      },
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0);
  },
);
