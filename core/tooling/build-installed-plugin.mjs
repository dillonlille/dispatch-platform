import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstalledPlugin as build } from '../sdk/tooling/build-installed-plugin.mjs';
const toolsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dashboard');
export const buildInstalledPlugin = options => build({ toolsRoot, ...options });
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const [pluginRoot, output] = process.argv.slice(2);
 const { readFileSync } = await import('node:fs');
 const { id } = JSON.parse(readFileSync(path.join(pluginRoot, 'dispatch-plugin.json')));
 console.log(JSON.stringify(await buildInstalledPlugin({ id, pluginRoot: path.resolve(pluginRoot), output: path.resolve(output) })));
}
