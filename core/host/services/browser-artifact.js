'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { rootExecutable } = require('../../shared/trusted-command-path');
const { hashFileSync, atomic } = require('../../core/installations/src/release-delivery-files');
const { fail, privateDirectory, privileged } = require('../controller/operations');

const MANIFEST = 'dispatch-browser-manifest.json';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function tree(root, sealed = false) {
  const files = [], directories = [];
  function visit(current) {
    const info = fs.lstatSync(current);
    if (fs.realpathSync(current) !== current || info.uid !== 0 || info.isSymbolicLink()
        || info.mode & 0o022) fail('directory_browser_unsafe');
    const relative = path.relative(root, current);
    if (relative && !/^[A-Za-z0-9_./-]+$/.test(relative)) fail('directory_browser_unsafe');
    if (info.isDirectory()) {
      if (sealed && (info.mode & 0o7777) !== 0o555) fail('directory_browser_unsafe');
      directories.push(relative);
      for (const name of fs.readdirSync(current).sort()) {
        if (current === root && name === MANIFEST) continue;
        visit(path.join(current, name));
      }
    } else {
      if (!info.isFile() || info.nlink !== 1) fail('directory_browser_unsafe');
      const mode = info.mode & 0o111 ? 0o555 : 0o444;
      if (sealed && (info.mode & 0o7777) !== mode) fail('directory_browser_unsafe');
      files.push({ path: relative, mode, sha256: hashFileSync(current) });
    }
  }
  visit(root);
  if (!files.some(file => file.path === 'chrome' && file.mode === 0o555)) fail('directory_browser_unsafe');
  return { version: 1, directories, files };
}

function inspectBrowser(paths, root) {
  const parent = path.join(paths.local, 'tools/directory-browser');
  if (path.dirname(root) !== parent || !/^[a-f0-9]{64}$/.test(path.basename(root))) fail('directory_browser_unsafe');
  const file = path.join(root, MANIFEST), info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1
      || (info.mode & 0o7777) !== 0o444 || info.size > 256 * 1024 || fs.realpathSync(file) !== file) fail('directory_browser_unsafe');
  const raw = fs.readFileSync(file, 'utf8');
  if (digest(raw) !== path.basename(root) || JSON.stringify(tree(root, true)) + '\n' !== raw) fail('directory_browser_unsafe');
  return root;
}

async function installBrowser(paths, source, lockFd) {
  if (!rootExecutable(path.join(source, 'chrome'))) fail('directory_browser_unsafe');
  const manifest = JSON.stringify(tree(source)) + '\n';
  const parent = privateDirectory(path.join(paths.local, 'tools/directory-browser'));
  const target = path.join(parent, digest(manifest));
  if (fs.existsSync(target)) return inspectBrowser(paths, target);
  // A failed installation is retained under an unpredictable staging name. It
  // can never be mistaken for a complete, content-addressed dependency bundle.
  const staging = path.join(parent, `.installing-${crypto.randomBytes(12).toString('hex')}`);
  const contents = JSON.parse(manifest), run = args => privileged(args, { lockFd });
  await run(['/usr/bin/install', '-d', '-o', '0', '-g', '0', '-m', '555', staging]);
  for (const relative of contents.directories.filter(Boolean)) {
    await run(['/usr/bin/install', '-d', '-o', '0', '-g', '0', '-m', '555', path.join(staging, relative)]);
  }
  for (const file of contents.files) {
    await run(['/usr/bin/install', '-o', '0', '-g', '0', '-m', file.mode.toString(8),
      path.join(source, file.path), path.join(staging, file.path)]);
  }
  if (JSON.stringify(tree(staging, true)) + '\n' !== manifest) fail('directory_browser_unsafe');
  const scratch = privateDirectory(path.join(paths.local, 'tmp'));
  const temporary = path.join(scratch, `browser-manifest-${crypto.randomBytes(12).toString('hex')}`);
  atomic(temporary, manifest);
  try { await run(['/usr/bin/install', '-o', '0', '-g', '0', '-m', '444', temporary, path.join(staging, MANIFEST)]); }
  finally { fs.unlinkSync(temporary); }
  fs.renameSync(staging, target);
  return inspectBrowser(paths, target);
}

module.exports = { inspectBrowser, installBrowser };
