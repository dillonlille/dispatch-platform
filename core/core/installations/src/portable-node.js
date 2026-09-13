'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const BUILTINS = ['cjs-module-lexer/lexer.js', 'cjs-module-lexer/dist/lexer.js', 'undici/undici-fetch.js',
  'acorn/dist/acorn.js', 'acorn-walk/dist/walk.js', 'minimatch/dist/cjs/index.bundle.js'];
// Carry Node's loader and libc too. Private RPATHs keep these dependencies out
// of every other program's library search on the restored host.
function bundleNode(executable, destination, runtimeRoot = '/usr/local/lib/dispatch-node') {
  if (fs.existsSync(destination) || !path.isAbsolute(destination)) throw Error('portable_node_invalid');
  const source = fs.realpathSync(executable);
  const interpreter = spawnSync('/usr/bin/patchelf', ['--print-interpreter', source], { encoding: 'utf8' });
  if (interpreter.status !== 0 || !path.isAbsolute(interpreter.stdout.trim())) throw Error('node_loader_unavailable');
  const loaderSource = fs.realpathSync(interpreter.stdout.trim());
  const listed = spawnSync(loaderSource, ['--list', source], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  if (listed.status !== 0 || /not found/.test(listed.stdout)) throw Error('node_dependencies_unavailable');
  fs.mkdirSync(destination, { mode: 0o755 });
  const target = path.join(destination, 'node'), libraries = path.join(destination, 'lib');
  fs.mkdirSync(libraries, { mode: 0o755 });
  fs.copyFileSync(source, target); fs.chmodSync(target, 0o755);
  const external = path.join(destination, 'host-files/usr/share/nodejs');
  fs.mkdirSync(external, { recursive: true, mode: 0o755 });
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\S+) => (\/[^\s]+) \(/.exec(line);
    if (!match || path.isAbsolute(match[1]) && fs.realpathSync(match[2]) === loaderSource) continue;
    const library = path.join(libraries, match[1]);
    if (path.basename(library) !== match[1] || fs.existsSync(library)) throw Error('node_dependencies_invalid');
    fs.copyFileSync(fs.realpathSync(match[2]), library); fs.chmodSync(library, 0o755);
  }
  for (const file of [target, ...fs.readdirSync(libraries).map(name => path.join(libraries, name))]) {
    const bytes = fs.readFileSync(file);
    for (const relative of BUILTINS) {
      const builtin = '/usr/share/nodejs/' + relative;
      if (!bytes.includes(Buffer.from(builtin + '\0'))) continue;
      const output = path.join(external, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
      fs.copyFileSync(builtin, output); fs.chmodSync(output, 0o444);
    }
  }
  const loader = path.join(libraries, 'ld-linux-x86-64.so.2');
  fs.copyFileSync(loaderSource, loader); fs.chmodSync(loader, 0o555);
  for (const file of [target, ...fs.readdirSync(libraries).filter(name => name !== 'ld-linux-x86-64.so.2').map(name => path.join(libraries, name))]) {
    const rpath = file === target ? '$ORIGIN/lib' : '$ORIGIN';
    const current = spawnSync('/usr/bin/patchelf', ['--print-rpath', file], { encoding: 'utf8' });
    if (current.status !== 0) throw Error('node_dependency_packaging_failed');
    if (current.stdout.trim() !== rpath && spawnSync('/usr/bin/patchelf', ['--set-rpath', rpath, file]).status !== 0) throw Error('node_dependency_packaging_failed');
    fs.chmodSync(file, file === target ? 0o755 : 0o555);
  }
  if (!/^\/[A-Za-z0-9_./-]+$/.test(runtimeRoot)) throw Error('node_runtime_path_invalid');
  const targetInterpreter = path.join(runtimeRoot, 'lib/ld-linux-x86-64.so.2');
  if (interpreter.stdout.trim() !== targetInterpreter && spawnSync('/usr/bin/patchelf', ['--set-interpreter', targetInterpreter, target]).status !== 0) throw Error('node_loader_packaging_failed');
  fs.chmodSync(target, 0o555);
  // Backup workers use umask 0077. Shared executable directories must remain
  // traversable by Core and DSP service accounts after recovery. Normalize
  // copied ownership too: root must own executables restored by its worker.
  function directories(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) directories(file);
      else fs.chownSync(file, process.geteuid(), process.getegid());
    }
    fs.chownSync(directory, process.geteuid(), process.getegid());
    fs.chmodSync(directory, 0o755);
  }
  directories(destination);
  const probe = spawnSync(loader, ['--library-path', libraries, target, '--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  if (probe.status !== 0 || !/^v[0-9]+\.[0-9]+\.[0-9]+\n$/.test(probe.stdout)) throw Error('portable_node_unusable');
  return probe.stdout.trim();
}
module.exports = { bundleNode, BUILTINS };
