'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { hash, verifyRelease } = require('../../shared/releases/package');
const { privateDirectory } = require('../../host/controller/operations');
const REPOSITORIES = Object.freeze({ core: 'dillonlille/dispatch-core', dsp: 'dillonlille/dispatch-dsp' });
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compareVersions = (a, b) => {
  const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
};
async function run(executable, args) {
  try { return (await execute(executable, args, { timeout: 180000, maxBuffer: 20 * 1024 * 1024 })).stdout; }
  catch { throw new Error('release_verification_failed'); }
}
async function download(url, file, maximum, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error('release_download_failed');
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('release_download_capacity');
  const fd = fs.openSync(file, 'wx', 0o600);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) throw new Error('release_download_capacity');
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
class GitHubReleases {
  constructor({ directory, releases, execute = run, fetchImpl = fetch, repositories = REPOSITORIES }) {
    this.repositories = repositories; this.root = privateDirectory(directory); this.releases = releases; this.execute = execute; this.fetch = fetchImpl;
  }
  async catalog(product) {
    const repository = this.repositories[product];
    if (!repository) throw new Error('release_product_invalid');
    const pages = JSON.parse(await this.execute('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]));
    if (!Array.isArray(pages) || pages.length > 20) throw new Error('release_history_capacity');
    return pages.flat().filter(item => !item.draft && !item.prerelease && typeof item.tag_name === 'string'
      && VERSION.test(item.tag_name.slice(1)) && item.tag_name.startsWith('v'))
      .sort((a, b) => compareVersions(a.tag_name.slice(1), b.tag_name.slice(1)));
  }
  async import(product, release, manifestName = 'release.json', expectedDigest = null) {
    const repository = this.repositories[product], version = release.tag_name.slice(1);
    if (!repository || !VERSION.test(version) || !Number.isSafeInteger(release.id)) throw new Error('release_identity_invalid');
    const archive = `dispatch-${product}-${version}.tar.gz`;
    const folder = fs.mkdtempSync(path.join(this.root, '.download-'));
    const asset = async (name, max) => {
      const matches = release.assets.filter(item => item.name === name);
      const url = `https://github.com/${repository}/releases/download/v${version}/${name}`;
      if (matches.length !== 1 || matches[0].browser_download_url !== url || matches[0].size > max || matches[0].size < 1) throw new Error('release_asset_invalid');
      const target = path.join(folder, name);
      await download(url, target, max, this.fetch);
      if (fs.statSync(target).size !== matches[0].size) throw new Error('release_asset_changed');
      return target;
    };
    try {
      const manifestFile = await asset(manifestName, 16 * 1024 * 1024);
      const manifest = JSON.parse(fs.readFileSync(manifestFile));
      if (manifest.product !== product || manifest.channel !== 'release' || manifest.version !== version
          || manifest.source?.repository !== repository || manifest.source?.ref !== 'refs/heads/main'
          || !/^[a-f0-9]{40}$/.test(manifest.source?.commit)) throw new Error('release_identity_invalid');
      const attest = file => this.execute('gh', ['attestation', 'verify', file, '--repo', repository,
        '--signer-workflow', `${repository}/.github/workflows/release.yml`, '--source-ref', 'refs/heads/main',
        '--source-digest', manifest.source.commit, '--deny-self-hosted-runners']);
      await attest(manifestFile);
      const tag = JSON.parse(await this.execute('gh', ['api', `repos/${repository}/git/ref/tags/v${version}`]));
      if (tag.object?.type !== 'commit' || tag.object.sha !== manifest.source.commit) throw new Error('release_tag_changed');
      const packed = await asset(archive, 512 * 1024 * 1024);
      await attest(packed);
      const extracted = path.join(folder, 'extracted');
      await this.execute('/usr/bin/python3', [path.join(__dirname, 'extract.py'), packed, extracted]);
      const digest = hash(JSON.stringify(manifest));
      if(expectedDigest && digest!==expectedDigest)throw new Error('release_asset_changed');
      const checked = verifyRelease(extracted, digest);
      if (JSON.stringify(checked) !== JSON.stringify(manifest)) throw new Error('release_asset_changed');
      for (const item of manifest.plugins) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(item.pluginId)) throw new Error('release_plugins_invalid');
        const plugin = require('../../shared/plugin-sdk/package-files').verifyPackage(path.join(extracted, 'plugins', item.pluginId), item.digest).plugin;
        if (plugin.id !== item.pluginId || plugin.version !== item.version) throw new Error('release_plugins_invalid');
      }
      const notes = fs.readFileSync(path.join(extracted, 'release-notes.md'), 'utf8');
      if (Buffer.byteLength(notes) > 100000 || !notes.trim()) throw new Error('release_notes_invalid');
      return await this.releases.stage(extracted, digest, { notes, source: manifest.source,
        publishedAt: release.published_at, url: `https://github.com/${repository}/releases/tag/v${version}` });
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  }
  async refresh(product) {
    const items = await this.catalog(product);
    // Import ascending versions so history is readable and newest wins. Always
    // reverify the newest: replacing a published version must fail closed.
    for (const item of items) {
      const known = Object.values(this.releases.state().releases[product]).some(row => row.version === item.tag_name.slice(1));
      if (!known || item === items.at(-1)) await this.import(product, item);
    }
    if (!items.length) throw new Error('release_feed_empty');
    const latest = this.releases.state().releases[product][this.releases.state().latest[product]];
    if (latest.version !== items.at(-1).tag_name.slice(1)) throw new Error('release_feed_regressed');
    return latest.digest;
  }
}
module.exports = { GitHubReleases, REPOSITORIES, compareVersions, download };
