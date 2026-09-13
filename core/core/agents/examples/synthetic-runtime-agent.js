'use strict';

const path = require('node:path');
const { success } = require('../../../shared/contracts/src');
const { parseStrictJson } = require('../../../shared/gateway/strict-json');
const { registrationToken } = require('../src');
const { DspRuntimeAgent } = require('dispatch-dsp/runtime/agent/src/index.js');

const MAX_CONFIG_BYTES = 16 * 1024;

function fail(code = 'invalid_runtime_agent_frame') {
  throw Object.assign(new Error(code), { code });
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
  return value;
}

function runtime(label) {
  return {
    system: { status: async () => success('ready', {
      label,
      components: {
        auth: { healthy: true, ready: true },
        collections: {
          healthy: true,
          ready: true,
          status: 'ready',
          data: { manager: { running: true } },
        },
      },
    }) },
    workforce: { day: async query => success('found', {
      label, businessDate: query.date, items: [],
    }) },
    sync: {
      status: async id => success('found', { label, id, desiredState: 'stopped' }),
      runNow: async id => success('queued', { label, id, replayed: false }),
    },
  };
}

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_CONFIG_BYTES) fail();
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.endsWith('\n') || raw.includes('\r') || raw.slice(0, -1).includes('\n')) fail();
  const config = exact(parseStrictJson(raw.slice(0, -1)), [
    'socketPath', 'runtimeKey', 'registrationToken', 'label',
  ]);
  if (typeof config.socketPath !== 'string' || !path.isAbsolute(config.socketPath)
      || typeof config.runtimeKey !== 'string' || typeof config.label !== 'string'
      || !/^[a-z]{3,24}$/.test(config.label)) fail();
  registrationToken(config.registrationToken);
  const selectedRegistrationToken = config.registrationToken;
  config.registrationToken = null;
  const agent = new DspRuntimeAgent({
    socketPath: config.socketPath,
    runtimeKey: config.runtimeKey,
    registrationToken: selectedRegistrationToken,
    client: runtime(config.label),
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await agent.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await agent.start();
  process.stdout.write(`${JSON.stringify({ ok: true, status: 'registered', label: config.label })}\n`);
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    status: [
      'runtime_agent_unauthorized', 'runtime_agent_conflict',
      'runtime_agent_protocol_mismatch', 'invalid_runtime_agent_frame',
    ].includes(error?.code) ? error.code : 'runtime_agent_unavailable',
  })}\n`);
  process.exitCode = 1;
});
