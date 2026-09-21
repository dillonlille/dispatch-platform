import { spawn } from 'node:child_process';
import { coreTests, dashboardTests } from './test-plan.js';

const mode = process.argv[2] ?? 'full';
if (!['full', 'build-full', 'build-dashboard', 'build-reuse', 'core'].includes(mode))
  throw new Error('Unknown validation mode');
const started = Date.now();
const failures: string[] = [];
async function run(name: string, command: string, args: string[], env = process.env) {
  const start = Date.now();
  process.stdout.write(`[start] ${name}\n`);
  const child = spawn(command, args, { stdio: 'inherit', env });
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
async function build(scope: string) {
  const built = npm('build');
  if (scope === 'reuse') {
    if (await built) await npm('test:smoke');
    return;
  }
  const browsers = run('browser setup', 'npx', [
    'playwright',
    'install',
    ...(process.env.CI === 'true' ? ['--with-deps'] : []),
    'chromium',
  ]);
  await Promise.all([
    built,
    browsers,
    npm('check'),
    npm('format:check'),
    built.then(async (ok) => {
      if (!ok) return;
      await Promise.all([
        npm('test:artifact'),
        run(
          'dashboard logic',
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', ...dashboardTests],
          { ...process.env, DISPATCH_TEST_BINARY: '.build/services/rust/dispatch-backend' },
        ),
      ]);
    }),
    Promise.all([built, browsers]).then(([ok, installed]) => ok && installed && npm('test:ui')),
  ]);
  // Measure after the other build checks finish so this process does not compete
  // with browser tests or compilers on the same runner.
  if (scope === 'full' && !failures.length)
    await run('Rust workload regression', process.execPath, [
      'node_modules/tsx/dist/cli.mjs',
      'tooling/benchmarks/benchmark-rust.ts',
      '--binary',
      '.build/services/rust/dispatch-backend',
      '--check',
      '--output',
      '/tmp/dispatch-rust-benchmark.json',
    ]);
}
async function core() {
  const python = run('Python tests', 'python3', [
    '-m',
    'unittest',
    'discover',
    '-s',
    'tests/tooling',
    '-p',
    '*_test.py',
  ]);
  const audit = run('dependency audit', 'npm', ['audit', '--audit-level=high']);
  if (await run('debug build', 'python3', ['tooling/cargo-build.py'])) {
    // Compile once before starting API fixtures; clippy/test no longer compete
    // with a second debug build. Release builds run on a separate CI runner.
    await Promise.all([
      npm('check:rust'),
      run('core API tests', process.execPath, [
        'node_modules/tsx/dist/cli.mjs',
        '--test',
        '--test-concurrency=1',
        // The build check owns the dashboard logic tests, in dashboard-only mode too.
        ...coreTests(),
      ]),
    ]);
  }
  await Promise.all([python, audit]);
}
if (mode === 'core') await core();
else if (mode === 'full') {
  // CI shards compile on separate runners; local runs share Cargo's build lock.
  await core();
  if (!failures.length) await build('full');
  // Local full checks still isolate capacity measurements from compilers.
  if (!failures.length) await npm('test:browseros');
} else await build(mode.replace('build-', ''));
process.stdout.write(`Validation ${mode}: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
if (failures.length) {
  process.stderr.write(`Failed checks: ${failures.join(', ')}\n`);
  process.exitCode = 1;
}
