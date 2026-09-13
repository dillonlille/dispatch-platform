'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function fail() { throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function createImmutableArtifact({ projectRoot, target, sourceFiles, executables = new Set(), includeModes = false }) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target) fail();
  try { fs.lstatSync(target); fail(); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  fs.mkdirSync(target, { mode: 0o755 });
  const files = [];
  try {
    for (const relative of sourceFiles) {
      const source = path.join(projectRoot, relative);
      const info = fs.lstatSync(source);
      if (path.relative(projectRoot, source) !== relative || !info.isFile() || info.isSymbolicLink()
          || info.nlink !== 1 || info.uid !== process.geteuid() || (info.mode & 0o022) !== 0
          || fs.realpathSync(source) !== source) fail();
      const content = fs.readFileSync(source);
      const destination = path.join(target, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      const mode = executables.has(relative) ? 0o555 : 0o444;
      fs.writeFileSync(destination, content, { mode, flag: 'wx' });
      files.push({ path: relative, ...(includeModes ? { mode: mode.toString(8) } : {}), sha256: sha256(content) });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = `${JSON.stringify({ version: 1, files })}\n`;
    fs.writeFileSync(path.join(target, 'manifest.json'), manifest, { mode: 0o444, flag: 'wx' });
    const directories = [];
    function collect(directory) {
      directories.push(directory);
      for (const name of fs.readdirSync(directory)) {
        const child = path.join(directory, name);
        if (fs.lstatSync(child).isDirectory()) collect(child);
      }
    }
    collect(target);
    for (const directory of directories.sort((a, b) => b.length - a.length)) fs.chmodSync(directory, 0o555);
    return { files: files.length, manifestSha256: sha256(manifest) };
  } catch (error) {
    try {
      const writable = directory => {
        fs.chmodSync(directory, 0o700);
        for (const name of fs.readdirSync(directory)) {
          const child = path.join(directory, name);
          if (fs.lstatSync(child).isDirectory()) writable(child);
        }
      };
      writable(target);
      fs.rmSync(target, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

module.exports = { createImmutableArtifact };
