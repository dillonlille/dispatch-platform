'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { configuration, PROJECT_ROOT } = require('./supervisor');

const CHECKS = Object.freeze([
  Object.freeze({ id: 'auth_broker', relative: 'runtime/auth-broker/bin/dispatch-auth-brokerctl', args: ['health'] }),
  Object.freeze({ id: 'collection_manager', relative: 'runtime/collection-manager/bin/dispatch-collectionctl', args: ['status'] }),
  Object.freeze({ id: 'runtime_gateway', relative: 'runtime/gateway/bin/dispatch-runtime-gatewayctl', args: ['health'] }),
  Object.freeze({ id: 'runtime_agent', relative: 'runtime/agent/bin/dispatch-runtime-agentctl', args: ['health'] }),
]);
const MAX_OUTPUT_BYTES = 16_384;

function healthyResponse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT_BYTES
      || !text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) return false;
  let value;
  try { value = JSON.parse(text.slice(0, -1)); } catch { return false; }
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && value.ok === true;
}

function checkRuntime({ environment = process.env, spawnImpl = spawnSync } = {}) {
  let config;
  try { config = configuration(environment); } catch { return false; }
  for (const check of CHECKS) {
    const script = path.join(PROJECT_ROOT, check.relative);
    let result;
    try {
      result = spawnImpl(process.execPath, ['--no-warnings', script, ...check.args], {
        cwd: path.dirname(script),
        env: config.childEnvironment,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return false; }
    if (result.error || result.signal || result.status !== 0 || !healthyResponse(result.stdout)) return false;
  }
  return true;
}

function main() {
  const healthy = checkRuntime();
  process.stdout.write(`${JSON.stringify({
    ok: healthy,
    status: healthy ? 'healthy' : 'runtime_unavailable',
    components: CHECKS.length,
  })}\n`);
  return healthy ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { CHECKS, MAX_OUTPUT_BYTES, healthyResponse, checkRuntime, main };
