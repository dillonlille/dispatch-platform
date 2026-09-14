import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { writeManifest, verifyArtifact } from '../services/releases/artifact.js';
const root = process.cwd(),
  out = path.join(root, '.build');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await viteBuild();
await build({
  entryPoints: {
    'api/main': 'api/main.ts',
    'tooling/cli': 'tooling/cli.ts',
    'tooling/supervisor': 'tooling/supervisor.ts',
    'services/runtime/auth-worker': 'services/browsers/auth-worker.ts',
    'services/runtime/collection-worker': 'services/browsers/collection-worker.ts',
  },
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
});
fs.cpSync('integrations/paycom/provider', path.join(out, 'services/runtime/provider'), {
  recursive: true,
});
fs.cpSync('services/browsers/assistance/vendor', path.join(out, 'services/runtime/assistance'), {
  recursive: true,
});
fs.mkdirSync(path.join(out, 'services/runtime/node_modules'), { recursive: true });
for (const name of ['package.json', 'package-lock.json'])
  fs.copyFileSync(name, path.join(out, name));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(out, 'tooling/build-info.json'), JSON.stringify({ commit }) + '\n');
execFileSync(
  'npm',
  ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'],
  { cwd: out, stdio: 'inherit' },
);
// Runtime artifacts have a complete regular-file inventory, no executable links.
function removeBins(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.bin') fs.rmSync(file, { recursive: true });
      else removeBins(file);
    }
  }
}
removeBins(path.join(out, 'node_modules'));
const manifest = writeManifest(out, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
verifyArtifact(out);
process.stdout.write(
  `Built ${manifest.version}: ${manifest.digest}\n${manifest.files.length} verified files in ${out}\n`,
);
