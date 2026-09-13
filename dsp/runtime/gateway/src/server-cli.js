'use strict';

const { RuntimeGatewayServer } = require('./server');
const { managedRuntimeConfiguration, createManagedRuntimeDispatchClient } = require('./managed-runtime');
const { RUNTIME_GATEWAY_PROTOCOL_VERSION } = require('dispatch-protocol/gateway/protocol');

async function main(environment = process.env, write = chunk => process.stdout.write(chunk)) {
  process.umask(0o077);
  let server;
  try {
    const configuration = managedRuntimeConfiguration(environment);
    const client = createManagedRuntimeDispatchClient(configuration);
    const plugins = require('../../plugin-host/index').createRuntimePlugins(configuration, client);
    client.system.includePaycom = () => plugins.enabled('paycom');
    const selectedClient = environment.DISPATCH_PROJECT_ROOT === '/opt/dispatch'
      ? Object.assign(Object.create(client), { paycomSetup: plugins.setup, pluginsManage: plugins.manage, pluginsInvoke: plugins.invoke, authorizePlugin: plugins.authorize,
        connectionsManage: require('dispatch-runtime-kit/supervisor/src/connections').createRuntimeConnections(configuration),
        diagnosticsSeed: input => require('../../supervisor/src/diagnostics-seed').createDiagnosticsSeed(configuration)(input) }) : Object.create(client);
    server = new RuntimeGatewayServer({
      socketPath: configuration.gatewaySocket,
      runtimeKey: configuration.runtimeKey,
      client: selectedClient,
    });
    selectedClient.runtimeExecution = require('../../supervisor/src/execution').createExecution({
      configuration, client: selectedClient, plugins, activeRequests: () => server.activeRequests,
    });
    await server.start();
  } catch {
    try { await server?.close(); } catch {}
    process.stderr.write('dispatch runtime gateway: unavailable\n');
    return 1;
  }
  write(`${JSON.stringify({
    ok: true,
    status: 'ready',
    protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
  })}\n`);
  let stopping = false;
  const shutdown = async code => {
    if (stopping) return;
    stopping = true;
    try { await server.close(); } finally { process.exit(code); }
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('uncaughtException', () => shutdown(1));
  process.once('unhandledRejection', () => shutdown(1));
  return new Promise(() => {});
}

if (require.main === module) main().then(code => { if (Number.isInteger(code)) process.exitCode = code; });
module.exports = { main };
