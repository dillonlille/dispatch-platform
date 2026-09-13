'use strict';

const path = require('node:path');
const { HOST_BRIDGE_ROOT, opaqueRuntimeSuffix, runtimeKey } = require('../../runtime-host-identity');
const { RuntimeAgentBridge } = require('./bridge');

function integer(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/.test(value)) throw new Error('runtime_agent_bridge_unavailable');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2 ** 31 - 1) throw new Error('runtime_agent_bridge_unavailable');
  return parsed;
}

async function main(environment = process.env, write = chunk => process.stdout.write(chunk)) {
  process.umask(0o077);
  if (process.geteuid() !== 0 || process.getegid() !== 0) return 1;
  let bridge;
  try {
    const selectedRuntimeKey = runtimeKey(environment.DISPATCH_RUNTIME_BRIDGE_KEY);
    const upstreamSocket = environment.DISPATCH_RUNTIME_BRIDGE_UPSTREAM_SOCKET;
    bridge = new RuntimeAgentBridge({
      runtimeKey: selectedRuntimeKey,
      downstreamSocket: path.join(HOST_BRIDGE_ROOT, opaqueRuntimeSuffix(selectedRuntimeKey), 'runtime-agent-hub.sock'),
      upstreamSocket,
      tenantUid: integer(environment.DISPATCH_RUNTIME_BRIDGE_TENANT_UID),
      tenantGid: integer(environment.DISPATCH_RUNTIME_BRIDGE_TENANT_GID),
      controllerUid: 0,
      controllerGid: 0,
      centralUid: integer(environment.DISPATCH_RUNTIME_BRIDGE_CENTRAL_UID),
    });
    await bridge.start();
  } catch {
    try { await bridge?.close(); } catch {}
    return 1;
  }
  write(`${JSON.stringify({ ok: true, status: 'ready' })}\n`);
  let closing = false;
  const close = async code => {
    if (closing) return;
    closing = true;
    try { await bridge.close(); } finally { process.exit(code); }
  };
  process.once('SIGINT', () => close(0));
  process.once('SIGTERM', () => close(0));
  process.once('uncaughtException', () => close(1));
  process.once('unhandledRejection', () => close(1));
  return new Promise(() => {});
}

if (require.main === module) main().then(code => { if (Number.isInteger(code)) process.exitCode = code; });
module.exports = { main, integer };
