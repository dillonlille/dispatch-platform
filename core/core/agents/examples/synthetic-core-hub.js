'use strict';

const readline = require('node:readline');
const { CoreRuntimeAgentHub, createRuntimeAgentDispatchClient } = require('../src');

function exact(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== required.length
      || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('invalid_runtime_agent_frame');
}

async function main(environment = process.env) {
  const socketPath = environment.DISPATCH_RUNTIME_AGENT_HUB_SOCKET;
  let authorities;
  try { authorities = JSON.parse(environment.DISPATCH_RUNTIME_AGENT_AUTHORITIES || ''); }
  catch { throw new Error('runtime_agent_unavailable'); }
  const hub = new CoreRuntimeAgentHub({ socketPath, authorities });
  await hub.start();
  process.stdout.write(`${JSON.stringify({ ok: true, status: 'ready' })}\n`);

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    Promise.resolve().then(async () => {
      const command = JSON.parse(line);
      if (command?.action === 'status') {
        exact(command, ['action']);
        return { ok: true, status: 'ready', data: hub.status() };
      }
      exact(command, ['action', 'runtimeKey']);
      if (command.action !== 'system.status') throw new Error('runtime_agent_unavailable');
      return createRuntimeAgentDispatchClient({ hub, runtimeKey: command.runtimeKey }).system.status();
    }).then(
      result => process.stdout.write(`${JSON.stringify(result)}\n`),
      () => process.stdout.write(`${JSON.stringify({ ok: false, status: 'runtime_agent_unavailable', data: null })}\n`),
    );
  });
  let closing = false;
  const close = async code => {
    if (closing) return;
    closing = true;
    input.close();
    try { await hub.close(); } finally { process.exit(code); }
  };
  process.once('SIGINT', () => close(0));
  process.once('SIGTERM', () => close(0));
  process.once('uncaughtException', () => close(1));
  process.once('unhandledRejection', () => close(1));
  return new Promise(() => {});
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
