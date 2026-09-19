import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { coreTests, dashboardTests, nativeShards } from '../tooling/test-plan.js';

const names = (directory: string, pattern: RegExp) =>
  fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => pattern.test(name))
    .map((name) => `${directory}/${name}`)
    .sort();

test('every test file is run by exactly one check of full validation and none is orphaned', () => {
  // API and logic tests: the core check takes what the dashboard build check does not.
  const files = names('tests', /\.test\.ts$/).filter((file) => !file.startsWith('tests/browser/'));
  assert(files.length > 20);
  assert.deepEqual([...coreTests(), ...dashboardTests].sort(), files);
  assert.equal(new Set([...coreTests(), ...dashboardTests]).size, files.length);
  for (const file of dashboardTests) assert(fs.existsSync(file), `${file} does not exist`);
  // `npm test` and the core check read the top of tests/ only.
  assert.deepEqual(
    files.filter((file) => file.split('/').length !== 2),
    [],
    'a test file in a subdirectory of tests/ is run by nothing',
  );
  const checks = fs.readFileSync('tooling/checks.ts', 'utf8');
  assert.match(checks, /\.\.\.coreTests\(\)/);
  assert.match(checks, /\.\.\.dashboardTests/);

  // Native suites also run in the core check, where they skip themselves without a browser.
  const native = Object.values(nativeShards).flat();
  assert.equal(new Set(native).size, native.length);
  for (const file of native) assert(coreTests().includes(file), `${file} is not a test file`);
  const gated = files.filter((file) =>
    /process\.env\.DISPATCH_TEST_NATIVE/.test(fs.readFileSync(file, 'utf8')),
  );
  assert.deepEqual(gated, [...native].sort(), 'a native suite is missing from its shard list');

  // Playwright takes every spec under its testDir; nothing else may hold one.
  const config = fs.readFileSync('playwright.config.ts', 'utf8');
  assert.match(config, /testDir: '\.\/tests\/browser'/);
  assert.doesNotMatch(config, /testMatch|testIgnore/);
  assert.deepEqual(
    names('tests', /\.spec\.ts$/).filter((file) => !file.startsWith('tests/browser/')),
    [],
  );
  assert(names('tests/browser', /\.spec\.ts$/).length > 10);
  assert.deepEqual(names('tests/browser', /\.test\.ts$/), []);

  // Python discovery is `-s tests -p '*_test.py'`: top level, that suffix.
  const python = names('tests', /\.py$/);
  assert.deepEqual(
    python.filter((file) => !/^tests\/[a-z_]+_test\.py$/.test(file)),
    [],
    'a Python file in tests/ is not matched by the unittest discovery pattern',
  );
  for (const directory of ['tooling', 'dashboard/src', 'shared', 'services'])
    assert.deepEqual(names(directory, /\.(test|spec)\.tsx?$|_test\.py$/), []);
});
