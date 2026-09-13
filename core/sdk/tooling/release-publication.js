'use strict';

// Shared publication tooling. This module never activates a release or contacts a DSP.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const execute = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value !== '0.0.0';

function identity({ repository, commit, version, product }) {
  if (!['core', 'dsp'].includes(product) || !new RegExp(`^[A-Za-z0-9_.-]+/dispatch-(?:${product}|platform)$`).test(repository)
      || !/^[a-f0-9]{40}$/.test(commit) || !validVersion(version)) throw new Error('release_identity_invalid');
  return { repository, commit, ref: 'refs/heads/main' };
}

function packageRelease({ candidate, output, repository, commit, version, notes, platformBundle }) {
  const { inventory, verifyRelease } = require('dispatch-protocol/releases/package');
  const original = JSON.parse(fs.readFileSync(path.join(candidate, 'release.json')));
  verifyRelease(candidate, sha256(JSON.stringify(original)));
  const source = identity({ repository, commit, version, product: original.product });
  if (original.channel !== 'development') throw new Error('release_candidate_required');
  if (typeof notes !== 'string' || notes.trim().length < 20 || Buffer.byteLength(notes) > 100000 || notes.includes('\0')) throw new Error('release_notes_invalid');
  candidate = fs.realpathSync(candidate);
  output = path.resolve(output);
  if (output === candidate || output.startsWith(candidate + path.sep) || fs.existsSync(output)) throw new Error('release_output_invalid');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.release-package-'));
  try {
    fs.cpSync(candidate, staging, { recursive: true });
    fs.chmodSync(path.join(staging, 'release.json'), 0o600);
    fs.unlinkSync(path.join(staging, 'release.json'));
    const packagePath = path.join(staging, 'code/package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath));
    if (pkg.name !== `dispatch-${original.product}` || pkg.version !== original.version) throw new Error('release_product_mismatch');
    pkg.version = version;
    fs.chmodSync(packagePath, 0o644);
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
    fs.writeFileSync(path.join(staging, 'release-notes.md'), notes.trim() + '\n', { mode: 0o644 });
    const files = inventory(staging);
    const manifest = { ...original, version, channel: 'release', source,
      sourceDigest: sha256(JSON.stringify(files.filter(file => file.path.startsWith('code/')))), files };
    if (platformBundle) {
      if (original.product !== 'core') throw new Error('release_platform_bundle_invalid');
      inventory(platformBundle);
      const bundle = JSON.parse(fs.readFileSync(path.join(platformBundle, 'manifest.json')));
      if (bundle.kind !== 'dispatch-platform-packages' || bundle.packages.length !== Object.keys(original.packages).length
          || bundle.packages.some(item => original.packages[item.name] !== item.version)) throw new Error('release_platform_bundle_invalid');
      const asset = 'platform-packages.tar.gz';
      execute('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', path.join(output, asset), '-C', platformBundle, '.']);
      manifest.platformBundle = { asset, sha256: sha256(fs.readFileSync(path.join(output, asset))) };
    }
    const serialized = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(staging, 'release.json'), serialized, { mode: 0o444 });
    const digest = sha256(JSON.stringify(manifest));
    verifyRelease(staging, digest);
    const archive = `dispatch-${manifest.product}-${version}.tar.gz`;
    execute('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', path.join(output, archive), '-C', staging, '.']);
    fs.writeFileSync(path.join(output, 'release.json'), serialized);
    fs.copyFileSync(path.join(staging, 'release-notes.md'), path.join(output, 'release-notes.md'));
    const names = [archive, 'release.json', 'release-notes.md'];
    if (manifest.platformBundle) names.push(manifest.platformBundle.asset);
    fs.writeFileSync(path.join(output, 'SHA256SUMS'), names.map(name => `${sha256(fs.readFileSync(path.join(output, name)))}  ${name}\n`).join(''));
    return { product: manifest.product, version, digest, archive, source };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function context(root, env = process.env) {
  const product = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).name.replace('dispatch-', '');
  const selected = { repository: env.GITHUB_REPOSITORY, commit: env.RELEASE_COMMIT, version: env.RELEASE_VERSION, product };
  identity(selected);
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'
      || env.GITHUB_SHA !== selected.commit || execute('git', ['rev-parse', 'HEAD'], root) !== selected.commit) throw new Error('release_main_dispatch_required');
  return selected;
}

function assertVerifiedMain(selected, root, run = execute) {
  const { repository, commit, product } = selected;
  const main = JSON.parse(run('gh', ['api', `repos/${repository}/commits/main`], root));
  if (main.sha !== commit) throw new Error('release_main_changed');
  const runs = JSON.parse(run('gh', ['api', `repos/${repository}/actions/workflows/checks.yml/runs?head_sha=${commit}&event=push&status=success&per_page=100`], root)).workflow_runs;
  if (!runs.some(item => item.head_sha === commit && item.head_branch === 'main' && item.event === 'push' && item.conclusion === 'success')) throw new Error('release_main_checks_required');
  // Check runs alone are not a merge approval; branch protection and the chat workflow govern integration.
  return { product, commit, verified: true };
}

function assertUnusedVersion(selected, root, run = execute) {
  const { repository, version } = selected;
  // Paginated lists avoid treating an authentication/network error as an absent tag.
  const tags = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/git/matching-refs/tags/v${version}`], root)).flat();
  const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`], root)).flat();
  if (tags.some(item => item.ref === `refs/tags/v${version}`) || releases.some(item => item.tag_name === `v${version}`)) throw new Error('release_version_exists');
  return releases.filter(item => !item.draft && !item.prerelease);
}

function componentVersions(manifest) {
  const components = new Map();
  for (const [name, version] of Object.entries(manifest.packages)) {
    const prefix = `code/node_modules/${name}/`;
    const files = manifest.files.filter(item => item.path.startsWith(prefix));
    if (!files.length) throw new Error('release_component_files_missing');
    components.set(`package:${name}@${version}`, sha256(JSON.stringify(files)));
  }
  for (const plugin of manifest.plugins) components.set(`plugin:${plugin.pluginId}@${plugin.version}`, plugin.digest);
  return components;
}

function assertComponentVersions(manifest, previous) {
  const next = componentVersions(manifest);
  for (const prior of previous) for (const [key, digest] of componentVersions(prior)) {
    if (next.has(key) && next.get(key) !== digest) throw new Error(`release_component_version_reused: ${key}; changed packages need a version bump in a reviewed PR`);
  }
}

function verifyPriorComponents(directory, selected, releases, root, run) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release.json')));
  for (const release of releases) {
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name)) throw new Error('release_history_invalid');
    const temporary = fs.mkdtempSync(path.join(path.dirname(directory), '.release-history-'));
    try {
      run('gh', ['release', 'download', release.tag_name, '--repo', selected.repository, '--pattern', 'release.json', '--dir', temporary], root);
      const file = path.join(temporary, 'release.json');
      if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('release_history_invalid');
      const prior = JSON.parse(fs.readFileSync(file));
      identity({ product: prior.product, repository: prior.source?.repository, commit: prior.source?.commit, version: prior.version });
      if (prior.product !== selected.product || prior.source.repository !== selected.repository || `v${prior.version}` !== release.tag_name) throw new Error('release_history_invalid');
      run('gh', ['attestation', 'verify', file, '--repo', selected.repository,
        '--signer-workflow', `${selected.repository}/.github/workflows/release.yml`, '--source-ref', 'refs/heads/main',
        '--source-digest', prior.source.commit, '--deny-self-hosted-runners'], root);
      assertComponentVersions(manifest, [prior]);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}

function verifyPublication(directory, selected) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release.json')));
  identity({ ...selected, product: manifest.product });
  if (manifest.product !== selected.product || manifest.version !== selected.version || manifest.channel !== 'release'
      || manifest.source?.commit !== selected.commit || manifest.source?.repository !== selected.repository
      || manifest.source?.ref !== 'refs/heads/main') throw new Error('release_publication_mismatch');
  const archive = `dispatch-${selected.product}-${selected.version}.tar.gz`;
  const names = [archive, 'release.json', 'release-notes.md'];
  if (manifest.platformBundle) {
    if (manifest.product !== 'core' || manifest.platformBundle.asset !== 'platform-packages.tar.gz'
        || sha256(fs.readFileSync(path.join(directory, 'platform-packages.tar.gz'))) !== manifest.platformBundle.sha256) throw new Error('release_platform_bundle_invalid');
    names.push(manifest.platformBundle.asset);
  }
  const expected = names.map(name => `${sha256(fs.readFileSync(path.join(directory, name)))}  ${name}\n`).join('');
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== expected) throw new Error('release_publication_digest_mismatch');
  return [...names, 'SHA256SUMS'];
}

function publish(directory, selected, root, run = execute) {
  const names = verifyPublication(directory, selected);
  assertVerifiedMain(selected, root, run);
  const prior = assertUnusedVersion(selected, root, run);
  verifyPriorComponents(directory, selected, prior, root, run);
  for (const name of names) run('gh', ['attestation', 'verify', path.join(directory, name), '--repo', selected.repository,
    '--signer-workflow', `${selected.repository}/.github/workflows/release.yml`, '--source-ref', 'refs/heads/main',
    '--source-digest', selected.commit, '--deny-self-hosted-runners'], root);
  // Recheck after network verification; concurrent main changes must never select different code.
  assertVerifiedMain(selected, root, run);
  const tag = `v${selected.version}`;
  run('gh', ['api', '--method', 'POST', `repos/${selected.repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${selected.commit}`], root);
  run('gh', ['release', 'create', tag, ...names.map(name => path.join(directory, name)), '--repo', selected.repository,
    '--verify-tag', '--draft', '--title', `Dispatch ${selected.product === 'core' ? 'Core' : 'DSP'} ${selected.version}`,
    '--notes-file', path.join(directory, 'release-notes.md')], root);
  const check = fs.mkdtempSync(path.join(path.dirname(directory), '.release-download-'));
  try {
    run('gh', ['release', 'download', tag, '--repo', selected.repository, '--dir', check], root);
    for (const name of names) if (!fs.readFileSync(path.join(check, name)).equals(fs.readFileSync(path.join(directory, name)))) throw new Error('release_upload_mismatch');
    assertVerifiedMain(selected, root, run);
    run('gh', ['release', 'edit', tag, '--repo', selected.repository, '--draft=false', '--latest'], root);
    const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', selected.repository, '--json', 'url,isDraft,tagName'], root));
    if (release.isDraft || release.tagName !== tag) throw new Error('release_publication_incomplete');
    return release;
  } finally { fs.rmSync(check, { recursive: true, force: true }); }
}

function main(root, args) {
  const [command, candidate, output] = args;
  const selected = context(root);
  if (command === 'guard') {
    if (execute('git', ['status', '--porcelain', '--untracked-files=no'], root)) throw new Error('release_source_modified');
    assertUnusedVersion(selected, root);
    return assertVerifiedMain(selected, root);
  }
  if (command === 'package') {
    if (selected.product === 'core' && !process.env.RELEASE_PLATFORM_BUNDLE) throw new Error('release_platform_bundle_required');
    return packageRelease({ ...selected, candidate, output, platformBundle: process.env.RELEASE_PLATFORM_BUNDLE,
      notes: fs.readFileSync(process.env.RELEASE_NOTES_FILE, 'utf8') });
  }
  if (command === 'publish') return publish(path.resolve(candidate), selected, root);
  throw new Error('usage: release.js guard | package CANDIDATE OUTPUT | publish OUTPUT');
}

module.exports = { identity, validVersion, packageRelease, context, assertVerifiedMain, assertUnusedVersion, assertComponentVersions, verifyPublication, publish, main };
