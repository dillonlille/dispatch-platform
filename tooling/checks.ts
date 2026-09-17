import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'full';
if (!['full', 'styles', 'reuse'].includes(mode)) throw new Error('Unknown validation mode');
const started = Date.now();
const failures: string[] = [];
async function run(name: string, command: string, args: string[]) {
  const start = Date.now();
  process.stdout.write(`[start] ${name}\n`);
  const child = spawn(command, args, { stdio: 'inherit' });
  const ok = await new Promise<boolean>((resolve) => {
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
  process.stdout.write(
    `[${ok ? 'pass' : 'fail'}] ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)\n`,
  );
  if (!ok) failures.push(name);
  return ok;
}
const npm = (name: string) => run(name, 'npm', ['run', name]);

// One runner shares the build; independent suites use separate fixture state/ports.
// Always wait for every child before cleanup or reporting success.
const rustChecks = mode === 'full' ? npm('check:rust') : Promise.resolve(true);
const debugBuild =
  mode === 'full'
    ? rustChecks.then((ok) => ok && run('debug build', 'cargo', ['build', '--locked']))
    : Promise.resolve(true);
const build = debugBuild.then((ok) => ok && npm('build'));
const checks: Promise<unknown>[] = [build];
if (mode === 'reuse') {
  checks.push(build.then((ok) => ok && npm('test:smoke')));
} else {
  checks.push(npm('check'), npm('format:check'));
  const browsers = run('browser setup', 'npx', [
    'playwright',
    'install',
    ...(process.env.CI === 'true' ? ['--with-deps'] : []),
    'chromium',
  ]);
  checks.push(browsers);
  checks.push(
    Promise.all([build, browsers]).then(
      ([built, installed]) => built && installed && npm('test:ui'),
    ),
  );
  if (mode === 'full') {
    const coreTests = debugBuild.then(
      (ok) => ok && run('test', 'npm', ['--ignore-scripts', 'test']),
    );
    checks.push(
      coreTests,
      rustChecks,
      // Real multi-DSP browsers need predictable headroom. Finish compilers and
      // synthetic API suites before starting the native capacity measurement.
      Promise.all([build, coreTests, rustChecks]).then(
        (results) => results.every(Boolean) && npm('test:browseros'),
      ),
      run('dependency audit', 'npm', ['audit', '--audit-level=high']),
      run('Python tests', 'python3', [
        '-m',
        'unittest',
        'discover',
        '-s',
        'tests',
        '-p',
        '*_test.py',
      ]),
      build.then((ok) => ok && npm('test:artifact')),
    );
  }
}
await Promise.all(checks);
process.stdout.write(`Validation ${mode}: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
if (failures.length) {
  process.stderr.write(`Failed checks: ${failures.join(', ')}\n`);
  process.exitCode = 1;
}
