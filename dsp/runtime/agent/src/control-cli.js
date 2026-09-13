'use strict';

const path = require('node:path');
const { queryRuntimeAgentStatus } = require('./status');

async function main(argv = process.argv.slice(2), environment = process.env, write = chunk => process.stdout.write(chunk)) {
  let result;
  try {
    if (argv.length !== 1 || argv[0] !== 'health') throw new Error('invalid');
    const socketPath = environment.DISPATCH_RUNTIME_AGENT_STATUS_SOCKET;
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath) {
      throw new Error('invalid');
    }
    result = await queryRuntimeAgentStatus(socketPath);
  } catch {
    result = { ok: false, status: 'runtime_agent_unavailable', data: null };
  }
  write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main };
