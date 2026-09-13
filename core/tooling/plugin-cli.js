'use strict';
const path = require('node:path');
const fs = require('node:fs');
async function main(argv) {
  const [command, noun, value] = argv;
  if (command === 'create' && noun === 'plugin' && value && argv.length === 3) {
    return require('./create-plugin').createPlugin({ id: value });
  }
  if (command !== 'plugin' || !['generate', 'check', 'dev'].includes(noun) || !value || argv.length !== 3) throw new Error('plugin_cli_arguments_invalid');
  const pluginRoot = /^[a-z][a-z0-9-]{0,63}$/.test(value) ? path.resolve(__dirname, '../plugins', value) : path.resolve(value);
  if (noun === 'generate') return require('./plugin-contracts').generateContracts(pluginRoot);
  const { prepareDevelopment, startDevelopment } = require('./plugin-development');
  const prepared = await prepareDevelopment(pluginRoot);
  if (noun === 'check') return { status: 'verified', ...prepared };
  const running = await startDevelopment(prepared.workspace);
  process.once('SIGINT', () => running.close()); process.once('SIGTERM', () => running.close());
  const { child, close, ...info } = running;
  fs.writeFileSync(path.join(prepared.workspace, 'development-receipt.json'), JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
  return info;
}
module.exports = { main };
