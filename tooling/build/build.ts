import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build as viteBuild } from 'vite';
import { writeManifest } from './artifact.js';
import { compressAssets } from './compress-assets.js';
import { replaceBuild } from './build-output.js';

const root = process.cwd(),
  out = path.join(root, '.build');
if (fs.existsSync(path.join(root, '.runtime')))
  throw new Error(
    'Build in an isolated checkout; the installed runtime is managed by the updater.',
  );
const manifest = await replaceBuild(out, async (staging) => {
  execFileSync('python3', ['tooling/cargo-build.py', '--release'], { stdio: 'inherit' });
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--no-deps', '--format-version=1', '--locked'], {
      encoding: 'utf8',
    }),
  );
  fs.mkdirSync(path.join(staging, 'services/rust'), { recursive: true });
  fs.copyFileSync(
    path.join(metadata.target_directory, 'release/dispatch-backend'),
    path.join(staging, 'services/rust/dispatch-backend'),
  );
  execFileSync(
    'python3',
    ['tooling/security/check-build-paths.py', path.join(staging, 'services/rust/dispatch-backend')],
    { stdio: 'inherit' },
  );
  await viteBuild({ build: { outDir: path.join(staging, 'dashboard') } });
  await compressAssets(path.join(staging, 'dashboard/assets'));
  // Every copy of the build carries its license. Installed updaters accept new files only under
  // dashboard/, and the server does not serve this one.
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'dashboard/LICENSE.txt'));
  fs.mkdirSync(path.join(staging, 'tooling'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(staging, 'tooling/build-info.json'),
    JSON.stringify({ commit, hostManagement: 1 }) + '\n',
  );
  writeManifest(staging, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
});
process.stdout.write(
  `Built ${manifest.version}: ${manifest.digest}\n${manifest.files.length} verified files in ${out}\n`,
);
