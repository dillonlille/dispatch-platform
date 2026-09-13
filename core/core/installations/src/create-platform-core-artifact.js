'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PROJECT_ROOT } = require('../../../shared/paths/runtime-paths');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function git(args) {
  const result = spawnSync('/usr/bin/git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(); return result.stdout;
}
function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) throw new Error();
  const [configFile, target] = argv;
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (Object.keys(config).sort().join(',') !== 'localRoot,port,publicOrigin,releaseId,unitRoot,version'
      || !/^[a-z][a-z0-9_.-]{2,95}$/.test(config.releaseId)
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(config.version)
      || !/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(config.publicOrigin)
      || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error();
  for (const value of [config.localRoot, config.unitRoot, target]) {
    if (typeof value !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(value) || path.resolve(value) !== value
        || value === PROJECT_ROOT || value.startsWith(`${PROJECT_ROOT}/`)) throw new Error();
  }
  if (git(['status', '--porcelain']).trim()) throw new Error('clean_checkout_required');
  config.sourceCommit = git(['rev-parse', 'HEAD']).trim();
  if (fs.existsSync(target)) throw new Error();
  fs.mkdirSync(target, { mode: 0o700 });
  require('./create-host-helper-artifact').main([path.join(target, 'host-helper-artifact')]);
  config.helperManifestSha256 = sha(fs.readFileSync(path.join(target, 'host-helper-artifact/manifest.json')));
  const root = path.join(target, 'core-artifact'); fs.mkdirSync(root, { mode: 0o755 });
  const write = (relative, contents, mode = 0o444) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { flag: 'wx', mode });
  };
  for (const entry of git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)) {
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error('unsupported_git_entry');
    const [, mode, object, relative] = match;
    if (!(/^(core|host|dashboard|shared|sdk|runtime|plugins)\//.test(relative) || ['bin/dispatch-api', 'bin/dispatch-dashboard', 'bin/dispatch-access-admin', 'bin/dispatch-plugin-collector'].includes(relative))
        || /\/(tests|examples|docs)\//.test(relative)) continue;
    if (relative.startsWith('plugins/') && !/^plugins\/[^/]+\/(dashboard\/|dispatch-plugin\.json$)/.test(relative)) continue;
    if (!['100644', '100755'].includes(mode)) throw new Error('unsupported_git_mode');
    const blob = spawnSync('/usr/bin/git', ['cat-file', 'blob', object], { cwd: PROJECT_ROOT, maxBuffer: 16 * 1024 * 1024 });
    if (blob.status !== 0 || blob.error) throw new Error('git_blob_unavailable');
    write(`code/${relative}`, blob.stdout, mode === '100755' ? 0o555 : 0o444);
  }
  for (const file of require('./release-frontend').buildFrontend(PROJECT_ROOT, config.sourceCommit, target)) {
    write(file.path, Buffer.from(file.data, 'base64'));
  }
  const manifestSha256 = require('./core-artifact-layout').finishCoreArtifact(root, config);
  process.stdout.write(JSON.stringify({ status: 'platform_core_artifact_created', sourceCommit: config.sourceCommit,
    core: { artifactPath: `/opt/dispatch-platform/releases/${config.releaseId}/core-artifact`, manifestSha256 },
    helperManifestSha256: config.helperManifestSha256 }) + '\n');
}
if (require.main === module) {
  try { main(); } catch { process.stderr.write('platform_core_artifact_failed\n'); process.exitCode = 1; }
}
module.exports = { main };
