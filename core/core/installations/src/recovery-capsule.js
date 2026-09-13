'use strict';
// Portable file inventory for encrypted recovery bundles. Payload files are
// private regular files; original ownership/modes are applied only on restore.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const MAX_FILES = 1000000;
const fail = () => { throw Object.assign(Error('recovery_capsule_invalid'), { code: 'recovery_capsule_invalid' }); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value)) fail();
  return value;
}
function relative(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..') || /[\0\r\n]/.test(value)) fail();
  return value;
}
function streamFile(source, target) {
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let out;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) fail();
    if (target) out = fs.openSync(target, 'wx', 0o600);
    const checksum = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0, length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      checksum.update(buffer.subarray(0, length)); size += length;
      if (size > before.size) fail();
      if (out !== undefined) {
        let offset = 0;
        while (offset < length) offset += fs.writeSync(out, buffer, offset, length - offset);
      }
    }
    const after = fs.fstatSync(fd);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== before.size) fail();
    if (out !== undefined) fs.fsyncSync(out);
    return { size, sha256: checksum.digest('hex') };
  } finally { fs.closeSync(fd); if (out !== undefined) fs.closeSync(out); }
}
function isDatabase(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return false;
    const header = Buffer.alloc(16);
    return fs.readSync(fd, header, 0, 16, 0) === 16 && header.toString() === 'SQLite format 3\0';
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ELOOP') return false; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function snapshotDatabase(source, target, sealedSource = false) {
  // Opening a WAL database read-only can still create -wal/-shm beside it.
  // Lifecycle snapshots have a fixed tree digest: never let SQLite open those
  // source files directly. Include committed WAL pages in the private copy.
  let work;
  const original = source;
  const copied = [];
  if (sealedSource) {
    work = fs.mkdtempSync(path.join(path.dirname(target), '.sqlite-read-'));
    source = path.join(work, 'database');
    try {
      for (const suffix of ['', '-wal']) {
        if (suffix && !fs.existsSync(original + suffix)) continue;
        copied.push([suffix, streamFile(original + suffix, source + suffix)]);
      }
      for (const [suffix, proof] of copied) {
        if (JSON.stringify(streamFile(original + suffix)) !== JSON.stringify(proof)) fail();
      }
    } catch (error) { fs.rmSync(work, { recursive: true, force: true }); throw error; }
  }
  const script = `import sqlite3,sys,urllib.parse,os
source,target=sys.argv[1:]
src=sqlite3.connect('file:'+urllib.parse.quote(source)+'?mode=ro',uri=True,timeout=30)
src.execute('PRAGMA trusted_schema=OFF')
dst=sqlite3.connect(target)
try:
 src.backup(dst)
 if dst.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise RuntimeError('database_corrupt')
finally:
 dst.close(); src.close()
os.chmod(target,0o600)
with open(target,'rb') as f: os.fsync(f.fileno())
`;
  try {
    const result = require('node:child_process').spawnSync('/usr/bin/python3', ['-I', '-c', script, source, target],
      { timeout: 120000, maxBuffer: 1024, encoding: 'utf8' });
    if (result.status !== 0 || result.error) fail();
    return streamFile(target);
  } finally { if (work) fs.rmSync(work, { recursive: true, force: true }); }
}
function capture(destination, roots, metadata, allowedOwners) {
  absolute(destination);
  if (fs.existsSync(destination) || !Array.isArray(roots) || !roots.length || !(allowedOwners instanceof Set)) fail();
  const entries = [], targets = new Set();
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.mkdirSync(path.join(destination, 'files'), { mode: 0o700 });
  for (const selected of roots) {
    const source = absolute(selected.source), target = absolute(selected.target);
    const excludeContents = new Set((selected.excludeContents || []).map(relative));
    const exclude = new Set((selected.exclude || []).map(relative));
    const overrides = Object.entries(selected.overrides || {}).map(([suffix, replacement]) => [relative(suffix), absolute(replacement)]);
    if (source === destination || destination.startsWith(source + '/') || [...targets].some(root =>
      target === root || target.startsWith(root + '/') || root.startsWith(target + '/'))) fail();
    targets.add(target);
    function visit(file, suffix) {
      if (exclude.has(suffix)) return;
      const override = overrides.find(([prefix]) => suffix === prefix || suffix.startsWith(prefix + '/'));
      if (override) file = path.join(override[1], suffix.slice(override[0].length));
      // Each database is copied using SQLite's backup API, including committed
      // WAL pages. Its transient sidecars must not overwrite that clean copy.
      if (/-(wal|shm)$/.test(file) && isDatabase(file.replace(/-(wal|shm)$/, ''))) return;
      if (entries.length >= MAX_FILES || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) fail();
      const info = fs.lstatSync(file), name = suffix ? path.join(target, suffix) : target;
      if (!allowedOwners.has(info.uid) || (info.mode & 0o7000)) fail();
      const entry = { path: name, uid: info.uid, gid: info.gid, mode: info.mode & 0o777 };
      if (info.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (/\0/.test(link)) fail();
        entries.push({ ...entry, type: 'link', link });
      } else if (info.isDirectory()) {
        entries.push({ ...entry, type: 'directory' });
        const names = () => fs.readdirSync(file).sort().filter(name => !/-(wal|shm)$/.test(name)
          || !isDatabase(path.join(file, name.replace(/-(wal|shm)$/, ''))));
        const beforeNames = names();
        if (!excludeContents.has(suffix)) for (const child of beforeNames) visit(path.join(file, child), suffix ? `${suffix}/${child}` : child);
        const after = fs.lstatSync(file);
        // SQLite may create/remove its own WAL index while backing up a closed
        // WAL database. Require the non-transient directory inventory to match.
        if (after.ino !== info.ino || JSON.stringify(beforeNames) !== JSON.stringify(names())) fail();
      } else if (info.isFile()) {
        const payload = `files/${String(entries.length).padStart(8, '0')}`;
        const content = isDatabase(file) ? snapshotDatabase(file, path.join(destination, payload), Boolean(override))
          : streamFile(file, path.join(destination, payload));
        entries.push({ ...entry, type: 'file', payload, ...content });
      } else fail(); // Sockets/PIDs and device nodes are recreated by supervision.
    }
    visit(source, '');
  }
  const manifest = { schemaVersion: 1, metadata, roots: [...targets], entries };
  const bytes = JSON.stringify(manifest) + '\n';
  fs.writeFileSync(path.join(destination, 'recovery.json'), bytes, { flag: 'wx', mode: 0o600 });
  return { sha256: hash(bytes), files: entries.filter(e => e.type === 'file').length,
    size: entries.reduce((sum, e) => sum + (e.size || 0), 0) };
}
function verify(directory, expectedDigest, allowedRoots, resolvePayload = null) {
  absolute(directory);
  if (!(allowedRoots instanceof Set) || !/^[a-f0-9]{64}$/.test(expectedDigest)) fail();
  for (const selected of [directory, path.join(directory, 'files')]) {
    if (!fs.lstatSync(selected).isDirectory() || fs.realpathSync(selected) !== selected) fail();
  }
  const manifestFile = path.join(directory, 'recovery.json'), info = fs.lstatSync(manifestFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024 ** 2) fail();
  const bytes = fs.readFileSync(manifestFile);
  if (hash(bytes) !== expectedDigest) fail();
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.roots) || !Array.isArray(manifest.entries)
      || !manifest.entries.length || manifest.entries.length > MAX_FILES) fail();
  if (!manifest.roots.length || new Set(manifest.roots).size !== manifest.roots.length
      || manifest.roots.some(root => !allowedRoots.has(absolute(root))
        || manifest.roots.some(other => other !== root && root.startsWith(other + '/')))) fail();
  const paths = new Map(), payloads = new Set(), localPayloads = new Set();
  for (const entry of manifest.entries) {
    absolute(entry.path);
    if (!manifest.roots.some(root => entry.path === root || entry.path.startsWith(root + '/')) || paths.has(entry.path)
        || !Number.isSafeInteger(entry.uid) || entry.uid < 0 || !Number.isSafeInteger(entry.gid) || entry.gid < 0
        || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail();
    paths.set(entry.path, entry);
    if (entry.type === 'file') {
      relative(entry.payload);
      if (!/^files\/[0-9]{8}$/.test(entry.payload) || payloads.has(entry.payload)) fail();
      const local = path.join(directory, entry.payload);
      const external = resolvePayload && entry.artifact ? resolvePayload(entry) : null;
      const actual = streamFile(external || local);
      if (!external) localPayloads.add(entry.payload);
      if (actual.size !== entry.size || actual.sha256 !== entry.sha256) fail();
      payloads.add(entry.payload);
    } else if (entry.type === 'link') {
      if (typeof entry.link !== 'string' || /[\0\r\n]/.test(entry.link)) fail();
      const target = path.resolve(path.dirname(entry.path), entry.link);
      if (!manifest.roots.some(root => target === root || target.startsWith(root + '/'))) fail();
    } else if (entry.type !== 'directory') fail();
  }
  for (const entry of paths.values()) {
    let parent = path.dirname(entry.path);
    while (parent !== '/') {
      if (paths.has(parent) && paths.get(parent).type !== 'directory') fail();
      parent = path.dirname(parent);
    }
  }
  if (manifest.roots.some(root => !paths.has(root))) fail();
  const actualPayloads = fs.readdirSync(path.join(directory, 'files')).map(name => `files/${name}`);
  if (actualPayloads.length !== localPayloads.size || actualPayloads.some(name => !localPayloads.has(name))) fail();
  return manifest;
}
function materialize(directory, stagingRoot, expectedDigest, allowedRoots) {
  const manifest = verify(directory, expectedDigest, allowedRoots);
  absolute(stagingRoot);
  if (fs.existsSync(stagingRoot)) fail();
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  for (const entry of manifest.entries.filter(e => e.type !== 'link')) {
    const file = path.join(stagingRoot, entry.path.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (entry.type === 'directory') fs.mkdirSync(file, { recursive: true, mode: 0o700 });
    else streamFile(path.join(directory, entry.payload), file);
  }
  // Create links last so payload placement never traverses a restored symlink.
  for (const entry of manifest.entries.filter(e => e.type === 'link')) {
    const file = path.join(stagingRoot, entry.path.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.symlinkSync(entry.link, file);
  }
  return manifest;
}
function installFresh(directory, expectedDigest, allowedRoots) {
  if (process.geteuid() !== 0) fail();
  const manifest = verify(directory, expectedDigest, allowedRoots);
  // Never use this restore primitive to overwrite a running installation. The
  // operator restores onto a clean host, or removes a stopped fixture first.
  for (const root of manifest.roots) {
    try { fs.lstatSync(root); fail(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let parent = path.dirname(root);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (fs.realpathSync(parent) !== parent) fail();
  }
  const stage = fs.mkdtempSync('/var/tmp/dispatch-recovery-');
  fs.rmdirSync(stage);
  try {
    materialize(directory, stage, expectedDigest, allowedRoots);
    for (const entry of [...manifest.entries].sort((a, b) => b.path.length - a.path.length)) {
      const file = path.join(stage, entry.path.slice(1));
      fs.lchownSync(file, entry.uid, entry.gid);
      if (entry.type !== 'link') fs.chmodSync(file, entry.mode);
    }
    for (const root of manifest.roots) {
      const parents = [];
      for (let parent = path.dirname(root); !fs.existsSync(parent); parent = path.dirname(parent)) parents.push(parent);
      fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o755 });
      // Shared release ancestors must be traversable even under umask 0077.
      // Existing parents and the archived private roots retain their own modes.
      for (const parent of parents) fs.chmodSync(parent, 0o755);
      // cp preserves symlinks and ownership across filesystems; rename is only
      // possible when the restored root shares the staging filesystem.
      const source = path.join(stage, root.slice(1));
      try { fs.renameSync(source, root); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        const result = require('node:child_process').spawnSync('/usr/bin/cp', ['--archive', '--no-target-directory', '--', source, root], { timeout: 600000 });
        if (result.status !== 0) fail();
      }
    }
    return manifest;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
module.exports = { capture, verify, materialize, installFresh, streamFile };
