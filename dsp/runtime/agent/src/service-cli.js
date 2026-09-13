'use strict';

const path = require('node:path');
const { createRuntimeGatewayDispatchClient } = require('dispatch-protocol/gateway/client');
const { managedRuntimeConfiguration } = require('../../gateway/src/managed-runtime');
const { MAX_UNIX_SOCKET_PATH_BYTES } = require('dispatch-protocol/transport/unix-socket');
const { DspRuntimeAgent } = require('./agent');
const { registrationTokenFileProvider } = require('dispatch-protocol/agent/credential-file');
const { RuntimeAgentStatusServer } = require('./status');
const { RUNTIME_AGENT_PROTOCOL_VERSION } = require('dispatch-protocol/agent/protocol');

function fail() { throw Object.assign(new Error('runtime_agent_unavailable'), { code: 'runtime_agent_unavailable' }); }

function socketEnvironment(environment, name, basename) {
  const value = environment[name];
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || path.basename(value) !== basename || Buffer.byteLength(value, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) fail();
  return value;
}

async function main(environment = process.env, write = chunk => process.stdout.write(chunk)) {
  process.umask(0o077);
  let agent;
  let statusServer;
  try {
    const configuration = managedRuntimeConfiguration(environment);
    const hubSocket = socketEnvironment(environment, 'DISPATCH_RUNTIME_AGENT_HUB_SOCKET', 'runtime-agent-hub.sock');
    const statusSocket = socketEnvironment(environment, 'DISPATCH_RUNTIME_AGENT_STATUS_SOCKET', 'runtime-agent-status.sock');
    const tokenFile = environment.DISPATCH_RUNTIME_AGENT_TOKEN_FILE;
    if (tokenFile !== configuration.paths.runtimeAgent.registrationToken
        || statusSocket !== configuration.paths.runtimeAgent.statusSocket) fail();
    agent = new DspRuntimeAgent({
      socketPath: hubSocket,
      runtimeKey: configuration.runtimeKey,
      registrationTokenProvider: registrationTokenFileProvider(tokenFile),
      client: createRuntimeGatewayDispatchClient({
        socketPath: configuration.gatewaySocket,
        runtimeKey: configuration.runtimeKey,
      }),
    });
    statusServer = new RuntimeAgentStatusServer({ socketPath: statusSocket, agent });
    await statusServer.start();
    agent.start().catch(error => {
      const status = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'runtime_agent_unavailable';
      process.stderr.write(`${JSON.stringify({ ok: false, status })}\n`);
    });
  } catch {
    try { await agent?.close(); } catch {}
    try { await statusServer?.close(); } catch {}
    process.stderr.write('dispatch runtime agent: unavailable\n');
    return 1;
  }
  write(`${JSON.stringify({
    ok: true,
    status: 'starting',
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
  })}\n`);
  let stopping = false;
  const shutdown = async code => {
    if (stopping) return;
    stopping = true;
    try { await agent.close(); }
    finally {
      try { await statusServer.close(); } finally { process.exit(code); }
    }
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('uncaughtException', () => shutdown(1));
  process.once('unhandledRejection', () => shutdown(1));
  return new Promise(() => {});
}

if (require.main === module) main().then(code => { if (Number.isInteger(code)) process.exitCode = code; });
module.exports = { main, socketEnvironment };
