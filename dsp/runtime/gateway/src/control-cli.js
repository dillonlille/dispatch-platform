'use strict';

const { failure } = require('dispatch-protocol/contracts/src');
const { managedRuntimeConfiguration } = require('./managed-runtime');
const { createRuntimeGatewayDispatchClient } = require('dispatch-protocol/gateway/client');

async function main(argv = process.argv.slice(2), environment = process.env, write = chunk => process.stdout.write(chunk)) {
  process.umask(0o077);
  if (argv.length !== 1 || argv[0] !== 'health') {
    write(`${JSON.stringify(failure('invalid_input'))}\n`);
    return 2;
  }
  try {
    const configuration = managedRuntimeConfiguration(environment);
    const client = createRuntimeGatewayDispatchClient({
      socketPath: configuration.gatewaySocket,
      runtimeKey: configuration.runtimeKey,
    });
    const result = await client.health();
    write(`${JSON.stringify(result)}\n`);
    return result.ok && result.status === 'ready' ? 0 : 1;
  } catch {
    write(`${JSON.stringify(failure('runtime_gateway_unavailable', { recoverable: true }))}\n`);
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main };
