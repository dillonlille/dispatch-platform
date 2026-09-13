import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildFrontend } from './build-plugin-frontend.mjs';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sealPackage } = require('./build-plugin-package');
const { validateManifest } = require('dispatch-protocol/plugin-sdk/catalog');


// Distribution packages are compiled from reviewed local source. They contain
// the pinned SDK and all other dependencies; none can resolve deployed source.
export async function buildInstalledPlugin({ id, output, pluginRoot = path.resolve('plugins', id), toolsRoot }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('plugin_build_input_invalid');
  pluginRoot = path.resolve(pluginRoot);
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'dispatch-plugin.json'), 'utf8')));
  if (manifest.id !== id) throw new Error('plugin_build_input_invalid');
  const packageEntries = manifest.package || { runtime: 'backend/installed.js', authentication: 'backend/auth/adapter.js', collections: 'backend/config/collection-manager.json' };
  if (manifest.package) require('./plugin-contracts').generateContracts(pluginRoot, { check: true });
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  if (typeof toolsRoot !== 'string') throw new Error('plugin_build_tools_required');
  const buildRequire = createRequire(path.join(path.resolve(toolsRoot), 'package.json'));
  const { rolldown } = await import(buildRequire.resolve('rolldown'));
  const allowedShared = new Set(['contracts/src/workforce-client.js', 'contracts/src/workforce.js', 'contracts/src/workforce-summary.js',
    'contracts/src/input.js', 'contracts/src/result.js', 'published/database.js'].map(name => require.resolve('dispatch-protocol/' + name)));
  const dependencies = new Set();
  const boundary = {
    name: 'dispatch-package-boundary',
    resolveId(source, importer) {
      if (isBuiltin(source)) return { id: source, external: true };
      if (!importer || source.startsWith('\0')) return;
      if (source === 'dispatch-sdk' || source.startsWith('dispatch-sdk/')) {
        const key = source === 'dispatch-sdk' ? '.' : './' + source.slice('dispatch-sdk/'.length);
        const entry = require('../package.json').exports[key];
        if (!entry) throw new Error('plugin_sdk_export_invalid');
        return { id: '../dependencies/dispatch-sdk/' + (typeof entry === 'string' ? entry : entry.default).replace(/^\.\//, ''), external: true };
      }
      if (source.startsWith('dispatch-protocol/')) {
        const resolved = require.resolve(source);
        if (!allowedShared.has(resolved)) throw new Error('plugin_dependency_boundary');
        return resolved;
      }
      if (!source.startsWith('.') && !path.isAbsolute(source)) throw new Error(`plugin_unresolved_dependency: ${source}`);
      let resolved = require.resolve(path.resolve(path.dirname(importer), source));
      if (resolved === path.join(pluginRoot, 'backend/src/paths.js')) resolved = path.join(pluginRoot, 'backend/package-paths.js');
      if (!resolved.startsWith(pluginRoot + '/') && (resolved === sdkRoot + '/index.js' || resolved.startsWith(sdkRoot + '/'))) {
        const relative = path.relative(sdkRoot, resolved);
        return { id: '../dependencies/dispatch-sdk/' + relative, external: true };
      }
      if (!resolved.startsWith(pluginRoot + '/') && !allowedShared.has(resolved)) throw new Error('plugin_dependency_boundary');
      dependencies.add(resolved.startsWith(pluginRoot + '/') ? 'plugin/' + path.relative(pluginRoot, resolved) : 'protocol/' + path.basename(resolved));
      return resolved;
    },
  };
  for (const [source, name] of [[packageEntries.runtime, 'runtime.js'], [packageEntries.authentication, 'authentication.js']].filter(([source]) => source)) {
    const bundle = await rolldown({ input: path.join(pluginRoot, source), platform: 'node', plugins: [boundary],
      onwarn(warning) { throw new Error(`plugin_bundle_${warning.code}`); } });
    try { await bundle.write({ file: path.join(output, 'backend', name), format: 'cjs', codeSplitting: false }); }
    finally { await bundle.close(); }
  }
  fs.cpSync(sdkRoot, path.join(output, 'dependencies/dispatch-sdk'), { recursive: true,
    filter: selected => selected === sdkRoot || !['tests', 'examples', 'docs', 'node_modules', 'tooling'].includes(path.relative(sdkRoot, selected).split(path.sep)[0]) });
  await buildFrontend({ pluginRoot, toolsRoot, output: path.join(output, 'frontend') });
  fs.mkdirSync(path.join(output, 'migrations'), { mode: 0o700 });
  if (packageEntries.collections) fs.copyFileSync(path.join(pluginRoot, packageEntries.collections), path.join(output, 'migrations/collections.json'));
  else fs.writeFileSync(path.join(output, 'migrations/collections.json'), JSON.stringify({ schemaVersion: 1, collectors: [], sources: [], plans: [], syncs: [] }) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(output, 'dispatch-plugin.json'), JSON.stringify({ ...manifest,
    runtime: 'backend/runtime.js', frontend: manifest.frontend ? 'frontend/index.js' : null,
    dashboard: null, published: manifest.published ? 'backend/runtime.js' : null,
    ...(manifest.package ? { package: { runtime: 'backend/runtime.js', authentication: packageEntries.authentication ? 'backend/authentication.js' : null, collections: 'migrations/collections.json' } } : {}),
  }) + '\n', { mode: 0o600 });
  function secure(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const selected = path.join(directory, entry.name);
      if (entry.isDirectory()) { fs.chmodSync(selected, 0o700); secure(selected); }
      else if (entry.isFile()) fs.chmodSync(selected, 0o600);
      else throw new Error('plugin_build_link_rejected');
    }
  }
  secure(output);
  return { id, version: manifest.version, ...sealPackage(output), dependencies: [...dependencies].sort() };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, output, toolsRoot] = process.argv.slice(2);
  if (!output) throw new Error('plugin_build_input_invalid');
  console.log(JSON.stringify(await buildInstalledPlugin({ id, output: path.resolve(output), toolsRoot })));
}
