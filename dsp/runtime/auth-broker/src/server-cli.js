'use strict';

const { defaultPaths } = require('./paths');
const { AuthBrokerServer } = require('./server');

async function main() {
  process.umask(0o077);
  const server = new AuthBrokerServer(defaultPaths());
  try {
    await server.start();
  } catch {
    process.stderr.write('dispatch auth broker: unavailable\n');
    return 1;
  }
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return new Promise(() => {});
}

if (require.main === module) main().then(code => { if (Number.isInteger(code)) process.exitCode = code; });
module.exports = { main };
