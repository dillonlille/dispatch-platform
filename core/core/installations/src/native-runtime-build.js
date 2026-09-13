'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha } = require('./release-delivery-contract');
const { hashFileSync } = require('./release-delivery-files');
const { removeStage } = require('./release-delivery-install');
const LEGACY_ENTRYPOINTS = require('../../../shared/legacy-entrypoints');

function buildNativeRuntime({ projectRoot, archive, sourceCommit, nodeExecutable = process.execPath,
  browserRoot = process.env.DISPATCH_BUILD_BROWSER_ROOT || '/opt/google/chrome', consumeStage = null }) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error('unsupported_native_build');
  const stage = fs.mkdtempSync(path.join(path.dirname(archive), 'native-build-'));
  function git(args, encoding = 'utf8') {
    const result = spawnSync('/usr/bin/git', args, { cwd: projectRoot, encoding, maxBuffer: 32 * 1024 ** 2 });
    if (result.status !== 0) throw Error('native_source_invalid');
    return result.stdout;
  }
  function write(relative, data, mode) {
    const target = path.join(stage, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, data, { flag: 'wx', mode });
  }
  try {
    if (git(['status', '--porcelain']).trim() || git(['rev-parse', 'HEAD']).trim() !== sourceCommit) throw Error('clean_checkout_required');
    for (const row of git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
      if (!match) throw Error('unsupported_git_entry');
      const [, mode, object, relative] = match;
      if (!/^(runtime|shared|sdk|plugins|compatibility)\//.test(relative) || /\/(tests|examples|docs)\//.test(relative)
          || /\.(md|test\.js)$/.test(relative)) continue;
      if (relative.startsWith('plugins/') && !/^plugins\/[^/]+\/(backend\/|dispatch-plugin\.json$)/.test(relative)) continue;
      if (relative.startsWith('compatibility/') && !/^compatibility\/(cdf|paycom)\//.test(relative)) continue;
      write(relative, git(['cat-file', 'blob', object], null), mode === '100755' ? 0o555 : 0o444);
    }
    for (const [provider, names] of Object.entries(LEGACY_ENTRYPOINTS)) for (const name of names) {
      const base = require('../../../shared/plugin-sdk/catalog').plugin(provider) ? `plugins/${provider}/backend` : `compatibility/${provider}`;
      const target = `/opt/dispatch/${base}/bin/${name}`;
      if (!fs.existsSync(path.join(stage, base, 'bin', name))) throw Error('missing_collector_entrypoint');
      write(`plugins/${provider}/bin/${name}`, `#!/usr/bin/env -S node --no-warnings\n'use strict';\nrequire(${JSON.stringify(target)});\n`, 0o555);
    }
    const nodeRoot = path.join(stage, 'dependencies/node/bin');
    fs.mkdirSync(path.dirname(nodeRoot), { recursive: true, mode: 0o755 });
    require('./portable-node').bundleNode(nodeExecutable, nodeRoot, '/opt/dispatch/dependencies/node/bin');
    const browserBase = fs.realpathSync(browserRoot);
    function copyBrowser(directory, relative = '') {
      for (const name of fs.readdirSync(directory).sort()) {
        const source = path.join(directory, name), info = fs.lstatSync(source), child = path.join(relative, name);
        if (info.isDirectory()) copyBrowser(source, child);
        else {
          const real = fs.realpathSync(source);
          if (!real.startsWith(browserBase + '/') || !fs.statSync(real).isFile()) throw Error('unsafe_browser_dependency');
          write(path.join('dependencies/browser', child), fs.readFileSync(real), fs.statSync(real).mode & 0o111 ? 0o555 : 0o444);
        }
      }
    }
    copyBrowser(browserBase);
    if (!fs.existsSync(path.join(stage, 'dependencies/browser/chrome'))) throw Error('browser_binary_missing');
    const files = [];
    function inventory(directory) {
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name), info = fs.lstatSync(file);
        if (info.isDirectory()) inventory(file);
        else files.push({ path: path.relative(stage, file), mode: (info.mode & 0o777).toString(8), size: info.size, sha256: hashFileSync(file) });
      }
    }
    inventory(stage);
    const bytes = JSON.stringify({ schemaVersion: 1, backend: 'native_service_v1', sourceCommit, platform: 'linux/amd64', files }) + '\n';
    write('runtime-release-manifest.json', bytes, 0o444);
    if (consumeStage) return consumeStage(stage, sha(bytes));
    return {artifactSha256:packNativeRuntime(stage, archive), embeddedManifestSha256:sha(bytes)};
  } finally { removeStage(stage); }
}
function packNativeRuntime(stage, archive) {
  const result = spawnSync('/usr/bin/python3', ['-I', path.join(__dirname, "./native-runtime-archive.py"), 'pack', stage, archive],
    {encoding:'utf8', timeout:300_000, maxBuffer:4096});
  require('./release-build-space').checkArchiveResult(result, 'native_archive_build_failed');
  return hashFileSync(archive);
}
module.exports = {buildNativeRuntime, packNativeRuntime};
