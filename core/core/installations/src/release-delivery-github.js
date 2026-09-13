'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fail } = require('./release-delivery-contract');
const API = 'https://api.github.com/repos/example-organization/dispatch-platform';
const DOWNLOAD_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function createGitHubReleaseSource({ token, fetcher = fetch }) {
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) fail('github_credentials_invalid');
  async function response(route, accept, timeout, headers = {}) {
    let url = `${API}${route}`;
    const signal = AbortSignal.timeout(timeout);
    for (let redirects = 0; redirects < 4; redirects += 1) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password || target.port
          || (target.hostname !== 'api.github.com' && !DOWNLOAD_HOSTS.has(target.hostname))) fail('github_redirect_invalid');
      const result = await fetcher(url, { redirect: 'manual', signal, headers: {
        ...headers, Accept: accept, 'User-Agent': 'Dispatch-Release-Delivery', 'X-GitHub-Api-Version': '2022-11-28',
        ...(target.hostname === 'api.github.com' ? { Authorization: `Bearer ${token}` } : {}),
      } });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get('location'); await result.body?.cancel();
        if (!location) fail('github_redirect_invalid'); url = new URL(location, url).href; continue;
      }
      if (!result.ok) { await result.body?.cancel(); fail(result.status === 401 || result.status === 403 ? 'github_access_failed' : 'github_unavailable'); }
      return result;
    }
    fail('github_redirect_invalid');
  }
  async function json(route) {
    const result = await response(route, 'application/vnd.github+json', 30_000);
    const chunks = []; let length = 0;
    for await (const chunk of result.body) { length += chunk.length; if (length > 4 * 1024 ** 2) fail('github_response_invalid'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('github_response_invalid'); }
  }
  async function download(asset, file, expected, onProgress = () => {}) {
    if (!Number.isSafeInteger(asset.id) || asset.id < 1 || asset.state !== 'uploaded' || asset.size !== expected.size
        || asset.digest !== `sha256:${expected.sha256}`) fail('release_asset_invalid');
    const receipt = `${file}.identity`;
    const identity = JSON.stringify({ id: asset.id, size: expected.size, sha256: expected.sha256 });
    function safe(filename) {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid() || stat.mode & 0o077) fail('unsafe_release_storage');
      return stat;
    }
    let offset = 0;
    if (fs.existsSync(file)) {
      const stat = safe(file);
      const matching = fs.existsSync(receipt) && safe(receipt).size < 1024 && fs.readFileSync(receipt, 'utf8') === identity;
      if (matching && stat.size <= expected.size) offset = stat.size;
      else { fs.unlinkSync(file); }
    }
    require('./release-delivery-files').atomic(receipt, identity);
    if (offset === expected.size) {
      if (await require('./release-delivery-files').hashFile(file) === expected.sha256) { fs.unlinkSync(receipt); onProgress(offset); return; }
      fs.unlinkSync(file); offset = 0;
    }
    const result = await response(`/releases/assets/${asset.id}`, 'application/octet-stream', 600_000,
      offset ? { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' });
    if (result.status === 206) {
      if (!offset || result.headers.get('content-range') !== `bytes ${offset}-${expected.size - 1}/${expected.size}`) {
        await result.body?.cancel(); fs.rmSync(file, { force: true }); fs.rmSync(receipt, { force: true }); fail('release_asset_invalid');
      }
    } else if (result.status === 200) { offset = 0; }
    else { await result.body?.cancel(); fail('release_asset_invalid'); }
    if (fs.existsSync(file)) safe(file);
    const handle = await fs.promises.open(file, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | (offset ? fs.constants.O_APPEND : fs.constants.O_TRUNC), 0o600);
    const hash = crypto.createHash('sha256'); let size = offset;
    try {
      if (offset) for await (const chunk of fs.createReadStream(file, { end: offset - 1 })) hash.update(chunk);
      onProgress(size);
      for await (const chunk of result.body) {
        size += chunk.length; if (size > expected.size) fail('release_asset_invalid');
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) { const item = await handle.write(chunk, written); if (!item.bytesWritten) fail('release_download_failed'); written += item.bytesWritten; }
        onProgress(size);
      }
      if (size !== expected.size) fail('release_download_incomplete');
      if (hash.digest('hex') !== expected.sha256) fail('release_checksum_failed');
      await handle.sync();
      fs.unlinkSync(receipt);
    } catch (error) {
      if (['release_asset_invalid', 'release_checksum_failed'].includes(error.code)) {
        fs.rmSync(file, { force: true }); fs.rmSync(receipt, { force: true });
      }
      throw error;
    } finally { await handle.sync(); await handle.close(); }
  }

  return {
    supportsResume: true,
    async list() {
      const result = [];
      for (let page = 1; page <= 10; page += 1) {
        const values = await json(`/releases?per_page=100&page=${page}`);
        if (!Array.isArray(values)) fail('github_response_invalid');
        result.push(...values); if (values.length < 100) break;
      }
      return result;
    },
    async verifyCommit(version, commit) {
      let ref = (await json(`/git/ref/tags/${encodeURIComponent(version)}`)).object;
      for (let depth = 0; ref?.type === 'tag' && depth < 4; depth += 1) ref = (await json(`/git/tags/${ref.sha}`)).object;
      if (ref?.type !== 'commit' || ref.sha !== commit) fail('release_commit_mismatch');
      const comparison = await json(`/compare/${commit}...main`);
      if (!['ahead', 'identical'].includes(comparison.status)) fail('release_commit_mismatch');
    }, download,
  };
}
module.exports = { createGitHubReleaseSource };
