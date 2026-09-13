'use strict';
const { createDashboardShell, checkedApiOrigin } = require('./shell');
const { checkedPublicOrigin } = require('../../core/api/http');
function parseArguments(argv) {
  const options = { host: '127.0.0.1', port: 4310, apiOrigin: null, publicOrigin: null, turnstile: false };
  const flags = { '--host': 'host', '--port': 'port', '--api-origin': 'apiOrigin', '--public-origin': 'publicOrigin' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new TypeError('dashboard_argument_invalid');
    seen.add(flag);
    if (flag === '--turnstile') options.turnstile = true;
    else if (Object.hasOwn(flags, flag) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) options[flags[flag]] = argv[++i];
    else throw new TypeError('dashboard_argument_invalid');
  }
  options.port = Number(options.port);
  if (!['127.0.0.1', '::1'].includes(options.host) || !Number.isInteger(options.port)
      || options.port < 1024 || options.port > 65535) throw new TypeError('dashboard_argument_invalid');
  const upstream = checkedApiOrigin(options.apiOrigin);
  if (Number(upstream.port) === options.port) throw new TypeError('api_proxy_loop');
  checkedPublicOrigin(options.publicOrigin);
  return options;
}
async function main(argv) {
  let options;
  try { options = parseArguments(argv); }
  catch { process.stderr.write('Usage: dispatch-dashboard --api-origin http://127.0.0.1:4311 [--port 4310] [--public-origin https://host] [--turnstile]\n'); return 2; }
  const server = createDashboardShell(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
  const close = () => server.close();
  process.once('SIGINT', close); process.once('SIGTERM', close);
  process.stdout.write(JSON.stringify({ ok: true, status: 'ready', service: 'dispatch-dashboard', port: options.port }) + '\n');
  return 0;
}
module.exports = { parseArguments, main };
