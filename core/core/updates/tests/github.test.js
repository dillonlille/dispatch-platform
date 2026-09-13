'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { GitHubReleases, compareVersions, download } = require('../github');
const { LocalReleases } = require('../local-releases');
const { inventory, hash } = require('../../../shared/releases/package');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-feed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = Object.fromEntries(['drain', 'snapshot', 'start', 'verify', 'restore'].map(key => [key, async () => true]));
  const releases = new LocalReleases({ directory: path.join(root, 'state'), devDspId: 'dev', hooks });
  const items = [], assets = new Map(), attestations = [];
  let denied = false, wrongTag = false;
  const execute = async (command, args) => {
    if (command === '/usr/bin/python3') return execFileSync(command, args, { encoding: 'utf8' });
    if (args[0] === 'attestation') { attestations.push(args); if (denied) throw new Error('untrusted'); return ''; }
    if (args.at(-1).includes('/git/ref/')) return JSON.stringify({ object: { type: 'commit', sha: (wrongTag ? 'b' : 'a').repeat(40) } });
    return JSON.stringify([items]);
  };
  const feed = new GitHubReleases({ directory: path.join(root, 'downloads'), releases, execute,
    fetchImpl: async url => new Response(assets.get(url)) });
  function add(version, content = version) {
    const folder = fs.mkdtempSync(path.join(root, 'source-'));
    fs.mkdirSync(path.join(folder, 'code')); fs.writeFileSync(path.join(folder, 'code/value'), content);
    fs.writeFileSync(path.join(folder, 'release-notes.md'), `Release ${version}\n\nNew synthetic functionality.`);
    const manifest = { schemaVersion: 1, product: 'dsp', version, channel: 'release', protocol: 1, minimumProtocol: 1,
      sourceDigest: 'a'.repeat(64), source: { repository: 'dillonlille/dispatch-dsp', commit: 'a'.repeat(40), ref: 'refs/heads/main' }, plugins: [], files: inventory(folder) };
    fs.writeFileSync(path.join(folder, 'release.json'), JSON.stringify(manifest));
    const archive = `dispatch-dsp-${version}.tar.gz`, output = path.join(root, `archive-${items.length}.tgz`);
    execFileSync('tar', ['-czf', output, '-C', folder, '.']);
    const release = { id: items.length + 1, tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [] };
    for (const [name, buffer] of [['release.json', fs.readFileSync(path.join(folder, 'release.json'))], [archive, fs.readFileSync(output)]]) {
      const url = `https://github.com/dillonlille/dispatch-dsp/releases/download/v${version}/${name}`;
      assets.set(url, buffer); release.assets.push({ name, size: buffer.length, browser_download_url: url });
    }
    items.push(release); return { release, digest: hash(JSON.stringify(manifest)) };
  }
  return { feed, releases, add, attestations, items, root, deny: () => { denied = true; }, wrongTag: () => { wrongTag = true; } };
}
test('verified feed stages history in version order and preserves a completed Dev test', async t => {
  const f = fixture(t), newest = f.add('1.10.0'); f.add('1.2.0');
  assert.equal(await f.feed.refresh('dsp'), newest.digest);
  assert.equal(f.releases.state().active.dsps.dev, undefined);
  const state = f.releases.state(); state.tested = newest.digest; f.releases.save(state);
  await f.feed.refresh('dsp'); assert.equal(f.releases.state().tested, newest.digest);
  assert.equal(f.releases.state().releases.dsp[newest.digest].source.repository, 'dillonlille/dispatch-dsp');
  assert(f.attestations.every(args => args.includes('--deny-self-hosted-runners') && args.includes('--source-digest')));
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
});
test('changed publication bytes cannot replace an immutable staged version', async t => {
  const f = fixture(t), one = f.add('1.0.0'); await f.feed.refresh('dsp');
  f.items.length = 0; f.add('1.0.0', 'replacement');
  await assert.rejects(f.feed.refresh('dsp'), /release_version_immutable/);
  assert.equal(f.releases.state().latest.dsp, one.digest);
});
test('untrusted provenance, changed tag and foreign asset URLs never stage code', async t => {
  for (const defect of ['deny', 'wrongTag', 'url']) {
    await t.test(defect, async t => {
      const f = fixture(t), { release } = f.add('1.0.0');
      if (defect === 'url') release.assets[0].browser_download_url = 'http://127.0.0.1/private'; else f[defect]();
      await assert.rejects(f.feed.refresh('dsp'));
      assert.equal(f.releases.state().latest.dsp, null);
    });
  }
});
test('downloads enforce streaming capacity when Content-Length is absent', async t => {
  const f = fixture(t);
  await assert.rejects(download('https://example.test', path.join(f.root, 'large'), 2,
    async () => new Response('overflow')), /release_download_capacity/);
});
test('extractor rejects traversal and symbolic links before writing outside its root', t => {
  const f = fixture(t);
  for (const name of ['../escape', '/tmp/escape', 'link']) {
    const archive = path.join(f.root, `${name === 'link' ? 'link' : 'path'}.tgz`);
    execFileSync('/usr/bin/python3', ['-c', "import tarfile,sys,io\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n m=tarfile.TarInfo(sys.argv[2]);m.type=tarfile.SYMTYPE if sys.argv[2]=='link' else tarfile.REGTYPE;m.linkname='/tmp';t.addfile(m,io.BytesIO())", archive, name]);
    assert.throws(() => execFileSync('/usr/bin/python3', [path.join(__dirname, '../extract.py'), archive,
      path.join(f.root, `extract-${Math.random()}`)], { stdio: 'pipe' }));
  }
  assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
});
