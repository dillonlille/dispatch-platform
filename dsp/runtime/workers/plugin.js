'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { boundedJson, MAX_INPUT_BYTES, MAX_RESULT_BYTES } = require('dispatch-sdk/protocol');
const { createWorkerClient } = require('dispatch-sdk/node');
const { verifyPackage } = require('dispatch-protocol/plugin-sdk/package-files');

async function main() {
  process.umask(0o077);
  if (process.geteuid() === 0) throw new Error('worker_boundary_invalid');
  const input = boundedJson(require('dispatch-protocol/transport/private-file').privateResult('/run/dispatch-plugin/request.json'), MAX_INPUT_BYTES);
  if (input.schemaVersion !== 1 || !['initialize', 'invoke', 'collect', 'publish', 'read', 'inspect', 'evidence'].includes(input.kind)
      || Object.keys(input).sort().join(',') !== 'action,digest,input,kind,pluginId,schemaVersion,timezone') throw new Error('worker_request_invalid');
  const manifest = verifyPackage('/opt/dispatch-plugin', input.digest);
  if (manifest.plugin.id !== input.pluginId || !manifest.plugin.runtime) throw new Error('worker_package_invalid');
  const dispatch = createWorkerClient();
  const implementation = require(path.join('/opt/dispatch-plugin', manifest.plugin.runtime));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  let value;
  if (input.kind === 'invoke') {
    const operation = manifest.plugin.actions.find(item => item.id === input.action);
    if (!operation) throw new Error('plugin_action_denied');
    const { operationInput, operationOutput } = require('dispatch-sdk/operations');
    value = await implementation.createPlugin({ dispatch }).invoke(input.action, operationInput(operation, input.input), { signal: controller.signal });
    if (value?.ok === true) operationOutput(operation, value.data);
  } else {
    if (typeof implementation[input.kind] !== 'function') throw new Error('plugin_entrypoint_invalid');
    value = await implementation[input.kind]({ dispatch, request: input.input, timezone: input.timezone, signal: controller.signal });
  }
  if (controller.signal.aborted) throw new Error('cancelled');
  const bytes = JSON.stringify({ ok: true, value: boundedJson(value, MAX_RESULT_BYTES - 128) });
  fs.writeFileSync('/run/dispatch-plugin/result.json', bytes, { mode: 0o600, flag: 'wx' });
}
if (require.main === module) main().catch(error => {
  const code = /^[a-z][a-z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'plugin_worker_failed';
  try { fs.writeFileSync('/run/dispatch-plugin/result.json', JSON.stringify({ ok: false, code }), { mode: 0o600, flag: 'wx' }); } catch {}
  process.exitCode = 1;
});
module.exports = { main };
