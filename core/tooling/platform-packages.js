'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const PACKAGES = { 'dispatch-sdk': 'sdk', 'dispatch-protocol': 'shared', 'dispatch-runtime-kit': 'packages/runtime-kit' };
const OMIT = new Set(['node_modules', '.git', 'tests', 'examples', 'docs', 'scripts', 'integration']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function inventory(root) {
  const result = [];
  const visit = relative => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const file = path.join(root, relative, name), entry = fs.lstatSync(file);
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error('package_entry_invalid');
      const selected = path.posix.join(relative, name);
      if (entry.isDirectory()) visit(selected);
      else result.push({ path: selected, sha256: hash(fs.readFileSync(file)), executable: Boolean(entry.mode & 0o111) });
    }
  };
  visit(''); return result;
}
function secureModes(root) {
  const stat=fs.lstatSync(root);
  if(stat.isSymbolicLink())throw new Error('package_entry_invalid');
  fs.chmodSync(root,stat.mode & ~0o022);
  if(stat.isDirectory())for(const name of fs.readdirSync(root))secureModes(path.join(root,name));
}
function copySource(source, target) {
  fs.cpSync(source, target, { recursive: true, dereference: false, filter: file => {
    const parts = path.relative(source, file).split(path.sep);
    if (parts.some(part => OMIT.has(part))) return false;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('package_entry_invalid');
    return true;
  } });
  secureModes(target);
}
function packageManifest(directory, name) {
  const file = path.join(directory, 'package.json'), value = JSON.parse(fs.readFileSync(file));
  if (value.name !== name) throw new Error('package_identity_invalid');
  if (name !== 'dispatch-sdk') {
    value.exports = {};
    for (const entry of inventory(directory).filter(entry => entry.path.endsWith('.js'))) {
      value.exports['./' + entry.path] = './' + entry.path;
      value.exports['./' + entry.path.slice(0, -3)] = './' + entry.path;
      if (entry.path.endsWith('/index.js')) value.exports['./' + entry.path.slice(0, -9)] = './' + entry.path;
    }
  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return value;
}
function buildPlatformPackages(output, { source = ROOT } = {}) {
  output = path.resolve(output);
  if (output === source || output.startsWith(source + path.sep) || fs.existsSync(output)) throw new Error('package_output_invalid');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const packages = [];
  for (const [name, relative] of Object.entries(PACKAGES)) {
    const directory = path.join(output, name);
    copySource(path.join(source, relative), directory);
    const manifest = packageManifest(directory, name);
    const files = inventory(directory);
    packages.push({ name, version: manifest.version, digest: hash(JSON.stringify(files)), files });
  }
  const manifest = { schemaVersion: 1, kind: 'dispatch-platform-packages', packages };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  fs.copyFileSync(__filename,path.join(output,'install.cjs'));
  return { ...manifest, digest: hash(JSON.stringify(manifest)) };
}
function installPlatformPackages(bundle, target, expected = null) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json')));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'dispatch-platform-packages'
      || manifest.packages.length !== 3 || new Set(manifest.packages.map(item => item.name)).size !== 3) throw new Error('package_bundle_invalid');
  for (const item of manifest.packages) {
    if (!Object.hasOwn(PACKAGES, item.name) || expected && expected[item.name] !== item.version) throw new Error('package_identity_invalid');
    const directory = path.join(bundle, item.name), files = inventory(directory);
    if (JSON.stringify(files) !== JSON.stringify(item.files) || hash(JSON.stringify(files)) !== item.digest) throw new Error('package_digest_mismatch');
    const selected = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    if (selected.name !== item.name || selected.version !== item.version) throw new Error('package_identity_invalid');
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  if(fs.realpathSync(target)!==path.resolve(target)||fs.lstatSync(target).isSymbolicLink())throw new Error('package_entry_invalid');
  fs.chmodSync(target,fs.statSync(target).mode&~0o022);
  for (const item of manifest.packages) {
    const selected = path.join(target, item.name);
    if (fs.existsSync(selected) && fs.lstatSync(selected).isSymbolicLink()) throw new Error('package_entry_invalid');
    fs.rmSync(selected, { recursive: true, force: true });
    fs.cpSync(path.join(bundle, item.name), selected, { recursive: true });
    secureModes(selected);
  }
  return { status: 'installed', packages: manifest.packages.map(({ name, version, digest }) => ({ name, version, digest })) };
}
if (require.main === module) {
  const [command, source, target] = process.argv.slice(2);
  if (command === 'build' && source && !target) console.log(JSON.stringify(buildPlatformPackages(source)));
  else if (command === 'install' && source && target) console.log(JSON.stringify(installPlatformPackages(source, target)));
  else throw new Error('usage: platform-packages.js build OUTPUT | install BUNDLE NODE_MODULES');
}
module.exports = { PACKAGES, inventory, buildPlatformPackages, installPlatformPackages };
