'use strict';

const { defaultPaths } = require('dispatch-runtime-kit/collection-manager/src/paths');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('./manager');

async function main() {
  process.umask(0o077);
  let store;
  let manager;
  try {
    store = new CollectionStore(defaultPaths());
    manager = new CollectionManager(store);
    await manager.start();
  } catch {
    try { store?.close(); } catch {}
    process.stderr.write('dispatch collection manager: unavailable\n');
    return 1;
  }
  let stopping = false;
  const shutdown = async code => {
    if (stopping) return;
    stopping = true;
    try { await manager.stop(); } finally { store.close(); }
    process.exit(code);
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('uncaughtException', () => shutdown(1));
  process.once('unhandledRejection', () => shutdown(1));
  return new Promise(() => {});
}

if (require.main === module) main().then(code => { if (Number.isInteger(code)) process.exitCode = code; });
module.exports = { main };
