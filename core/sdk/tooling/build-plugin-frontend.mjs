import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildFrontend({ pluginRoot, output, toolsRoot }) {
  if (typeof toolsRoot !== 'string') throw new Error('plugin_build_tools_required');
  const require = createRequire(path.join(path.resolve(toolsRoot), 'package.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'dispatch-plugin.json'), 'utf8'));
  if (!manifest.frontend) return;
  const { build } = await import(require.resolve('vite'));
  const { default: react } = await import(require.resolve('@vitejs/plugin-react'));
  await build({ configFile: false, root: path.resolve(toolsRoot), publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') }, plugins: [react()],
    resolve: { alias: { 'dispatch-sdk/operations': path.join(sdkRoot, 'src/operations.js'), 'lucide-react': path.join(path.dirname(require.resolve('lucide-react/package.json')), require('lucide-react/package.json').module) } },
    build: { outDir: output, emptyOutDir: false, cssCodeSplit: false,
      lib: { entry: path.join(pluginRoot, manifest.frontend), name: 'DispatchBuiltPlugin', formats: ['iife'], fileName: () => 'index.js', cssFileName: 'styles' },
      rolldownOptions: { external: ['react', 'react/jsx-runtime', '@tanstack/react-query', 'dispatch-sdk/ui'],
        output: { globals: { react: 'DispatchPluginHost.react', 'react/jsx-runtime': 'DispatchPluginHost.jsx',
          '@tanstack/react-query': 'DispatchPluginHost.query', 'dispatch-sdk/ui': 'DispatchPluginHost.ui' },
        footer: `globalThis.DispatchPluginHost.register(Object.assign({apiVersion:1,version:${JSON.stringify(manifest.version)}},DispatchBuiltPlugin));` } },
    },
  });
}
