'use strict';
const legacyArgs = argv => argv.includes('--port') ? argv : [...argv, '--port', '4310'];
function parseArguments(argv = process.argv.slice(2)) { return require('../../core/api/main').parseArguments(legacyArgs(argv)); }
function usage() {
  return 'UI service: dispatch-dashboard --api-origin http://127.0.0.1:4311 [--port 4310] [--public-origin https://host] [--turnstile]\n\n'
    + 'Without --api-origin, existing combined deployments remain supported:\n'
    + require('../../core/api/main').usage().replaceAll('dispatch-api', 'dispatch-dashboard').replaceAll('4311', '4310');
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.includes('--help')) { process.stdout.write(usage() + '\n'); return 0; }
  if (argv.includes('--api-origin')) return require('./shell-main').main(argv);
  return require('../../core/api/main').main(legacyArgs(argv), { ...dependencies,
    serverFactory: require('./server').createDashboardServer, compatibility: true });
}
module.exports = { parseArguments, usage, main };
