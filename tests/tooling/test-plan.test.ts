import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allTests,
  coreTests,
  dashboardTests,
  nativeShards,
  ruleTests,
} from '../../tooling/ci/test-plan.js';

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
  // npm test and CI share recursive discovery; support files are never executable tests.
  assert.deepEqual(allTests(), files);
  assert.deepEqual(
    files.filter((file) => !/^tests\/(api|dashboard|providers|tooling)\//.test(file)),
    [],
  );
  const runner = fs.readFileSync('tooling/testing/test.ts', 'utf8');
  assert.match(runner, /\.\.\.allTests\(\)/);
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts.test, 'tsx tooling/testing/test.ts');
  const checks = fs.readFileSync('tooling/ci/checks.ts', 'utf8');
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

  // Python discovery owns tests/tooling, with the same suffix as before.
  const python = names('tests', /\.py$/);
  assert.deepEqual(
    python.filter((file) => !/^tests\/tooling\/[a-z_]+_test\.py$/.test(file)),
    [],
    'a Python file in tests/ is not matched by the unittest discovery pattern',
  );
  assert.match(checks, /'tests\/tooling'/);
  for (const directory of ['tooling', 'dashboard/src', 'shared', 'services'])
    assert.deepEqual(names(directory, /\.(test|spec)\.tsx?$|_test\.py$/), []);
});

test('check:rules runs the dashboard logic and the listed source rules, which CI runs too', () => {
  assert.equal(new Set(ruleTests).size, ruleTests.length);
  for (const file of dashboardTests) assert(ruleTests.includes(file), `${file} is not a rule`);
  for (const file of ruleTests.filter((file) => !dashboardTests.includes(file)))
    assert(coreTests().includes(file), `${file} is not run by the core check`);
  assert.match(fs.readFileSync('tooling/ci/rules.ts', 'utf8'), /\.\.\.ruleTests/);
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts['check:rules'], 'tsx tooling/ci/rules.ts');
});
