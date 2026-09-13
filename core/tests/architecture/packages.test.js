'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { verify } = require('../../tooling/verify-boundaries');
const ROOT = path.resolve(__dirname, "../..");
function isolated(t, roots) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-package-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  for (const relative of new Set([...roots, 'sdk'])) fs.cpSync(path.join(ROOT, relative), path.join(target, relative), {
    recursive: true,
    filter: source => !['tests', 'examples', 'scripts', 'integration', 'node_modules', 'docs'].includes(path.basename(source)),
  });
  return target;
}
function load(root, modules) {
  const result = spawnSync(process.execPath, ['--no-warnings', '-e', modules.map(file => `require(${JSON.stringify(path.join(root, file))});`).join('\n')],
    { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
}
test('Core and DSP source imports obey the independent application boundaries', () => {
  assert.equal(verify().ok, true);
});
test('Core loads dashboard, owner onboarding, updater and host control without the DSP application', t => {
  const root = isolated(t, ['core', 'host', 'dashboard', 'shared', 'plugins/paycom/dispatch-plugin.json', 'plugins/paycom/dashboard']);
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
  load(root, ['dashboard/server/main.js', 'core/installations/src/index.js',
    'core/installations/src/owner-onboarding.js', 'core/installations/src/platform-core-update.js',
    'core/installations/src/core-systemd-deployment.js', 'core/agents/src/index.js']);
});
test('DSP loads its complete application with only its own source and the protocol', t => {
  const root = isolated(t, ['runtime', 'shared', 'plugins/paycom/dispatch-plugin.json', 'plugins/paycom/backend']);
  assert.equal(fs.existsSync(path.join(root, 'core')), false);
  load(root, ['runtime/agent/src/index.js', 'runtime/gateway/src/index.js',
    'runtime/supervisor/src/supervisor.js', 'runtime/supervisor/src/paycom-setup.js',
    'runtime/auth-broker/src/server.js', 'runtime/collection-manager/src/manager.js',
    'runtime/sdk/src/index.js']);
});
test('the boundary verifier rejects a DSP importing platform authority', t => {
  const root = isolated(t, ['core', 'host', 'dashboard', 'runtime', 'shared', 'plugins']);
  fs.writeFileSync(path.join(root, 'runtime/forbidden.js'), "require('../core/accounts/src');\n");
  assert.throws(() => verify(root), /runtime\/forbidden.js imports core/);
});

test('runtime entry modules load when no optional plugin is bundled', t => {
  const root = isolated(t, ['runtime', 'shared']);
  fs.mkdirSync(path.join(root, 'plugins'));
  load(root, ['runtime/auth-broker/src/server.js', 'runtime/gateway/src/server-cli.js', 'runtime/supervisor/src/supervisor.js', 'runtime/collection-manager/src/manager.js']);
});
