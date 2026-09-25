import { spawn } from 'node:child_process';
import os from 'node:os';
import { assessmentFixture } from '../testing/ci-tools.js';
import { coreTests, dashboardTests } from './test-plan.js';

// One job of the platform checks, or locally the whole suite in sequence. CI runs each mode
// on its own runner: `build` packages the runtime, and the modes that need it download that
// package into `.build` first.
const mode = process.argv[2] ?? 'full';
const modes = ['full', 'build', 'checks', 'browser', 'core', 'api', 'benchmark', 'smoke'];
if (!modes.includes(mode)) throw new Error('Unknown validation mode');
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
const npm = (name: string, ...args: string[]) =>
  run(name, 'npm', ['run', name, ...(args.length ? ['--', ...args] : [])]);
/** Source privacy, types, formatting, bundle budget and dashboard logic against `.build`. */
function checks() {
  return Promise.all([
    npm('check:privacy'),
    npm('check'),
    npm('format:check'),
    npm('test:artifact'),
    run(
      'dashboard logic',
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', ...dashboardTests],
      { ...process.env, DISPATCH_TEST_BINARY: '.build/services/rust/dispatch-backend' },
    ),
  ]);
}
/** The workload regression, against the build already in `.build`. */
function benchmark() {
  return run('Rust workload regression', process.execPath, [
    'node_modules/tsx/dist/cli.mjs',
    'tooling/benchmarks/benchmark-rust.ts',
    '--binary',
    '.build/services/rust/dispatch-backend',
    '--check',
    '--output',
    '/tmp/dispatch-rust-benchmark.json',
  ]);
}
function installBrowsers() {
  return run('browser setup', 'npx', [
    'playwright',
    'install',
    ...(process.env.CI === 'true' ? ['--with-deps'] : []),
    'chromium',
  ]);
}
/**
 * One shard of the browser suite against the build already in `.build`, as `browser 3/8`.
 * A manual lane names a spec or test after the shard; shards it leaves empty still pass.
 */
async function browser() {
  const shard = process.argv[3];
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard ?? '')) throw new Error('Browser shard required, as 1/8');
  const only = process.argv.slice(4).filter(Boolean);
  // The browser downloads and installs its system packages while Cargo compiles the
  // fixture; test:ui then finds the fixture already built.
  const fixture = assessmentFixture(process.env, process.cwd())
    ? Promise.resolve(true)
    : run('assessment fixture', 'cargo', ['build', '--locked', '--example', 'assessment-fixture']);
  const ready = await Promise.all([installBrowsers(), fixture]);
  // Three workers on a four-core runner: the fourth core keeps the private servers and the
  // sign-in animation responsive, so long multi-login tests stay well inside their budget.
  if (ready.every(Boolean))
    await npm(
      'test:ui',
      `--shard=${shard}`,
      '--workers=3',
      ...(only.length ? ['--pass-with-no-tests', ...only] : []),
    );
}
/** Rust formatting, lints and tests: `npm run check:rust` compiles what it checks. */
function core() {
  return npm('check:rust');
}
/** The API tests against a debug backend, with the Python tooling tests and the npm audit. */
async function api() {
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
    await run('core API tests', process.execPath, [
      'node_modules/tsx/dist/cli.mjs',
      '--test',
      // Every test file owns its servers, ports, state and mail, so files run in parallel.
      `--test-concurrency=${os.availableParallelism()}`,
      // The checks mode owns the dashboard logic tests.
      ...coreTests(),
    ]);
  }
  await Promise.all([python, audit]);
}
if (mode === 'build') await npm('build');
else if (mode === 'checks') await checks();
else if (mode === 'browser') await browser();
else if (mode === 'core') await core();
else if (mode === 'api') await api();
else if (mode === 'benchmark') await benchmark();
else if (mode === 'smoke') await npm('test:smoke');
else {
  // Locally, in sequence: CI's jobs share one machine here, and Cargo's build lock.
  await core();
  if (!failures.length) await api();
  if (!failures.length) await npm('build');
  if (!failures.length) await checks();
  if (!failures.length && (await installBrowsers())) await npm('test:ui');
  if (!failures.length) await benchmark();
  if (!failures.length) await npm('test:browseros');
}
process.stdout.write(`Validation ${mode}: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
if (failures.length) {
  process.stderr.write(`Failed checks: ${failures.join(', ')}\n`);
  process.exitCode = 1;
}
