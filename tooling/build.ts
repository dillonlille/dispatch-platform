import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build as viteBuild } from 'vite';
import { writeManifest, verifyArtifact } from './artifact.js';
const root = process.cwd(),
  out = path.join(root, '.build');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync('python3', ['tooling/cargo-build.py', '--release'], { stdio: 'inherit' });
fs.mkdirSync(path.join(out, 'services/rust'), { recursive: true });
fs.copyFileSync(
  'target/release/dispatch-backend',
  path.join(out, 'services/rust/dispatch-backend'),
);
await viteBuild();
fs.mkdirSync(path.join(out, 'tooling'), { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(out, 'tooling/build-info.json'), JSON.stringify({ commit }) + '\n');
const manifest = writeManifest(out, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
verifyArtifact(out);
process.stdout.write(
  `Built ${manifest.version}: ${manifest.digest}\n${manifest.files.length} verified files in ${out}\n`,
);
