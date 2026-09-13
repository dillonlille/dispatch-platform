'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { RUNTIME_GATEWAY_PROTOCOL_VERSION } = require('dispatch-protocol/gateway/protocol');
const { RUNTIME_AGENT_PROTOCOL_VERSION } = require('dispatch-protocol/agent/protocol');

const ROOT = '/opt/dispatch';
const MANIFEST_FILE = path.join(ROOT, 'runtime-release-manifest.json');
const SOURCE_ROOTS = ['runtime', 'shared', 'plugins', 'compatibility/cdf', 'compatibility/paycom'];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sourceFiles() {
  const values = [];
  const visit = relative => {
    const absolute = path.join(ROOT, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail('unsafe_runtime_source');
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(path.posix.join(relative, child));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) fail('unsafe_runtime_source');
    values.push({ absolute, relative, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid });
  };
  for (const relative of SOURCE_ROOTS) visit(relative);
  return values;
}

function treeDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const body = fs.readFileSync(file.absolute);
    hash.update(file.relative, 'utf8');
    hash.update('\0');
    hash.update(file.mode.toString(8), 'ascii');
    hash.update('\0');
    hash.update(String(file.uid), 'ascii');
    hash.update('\0');
    hash.update(String(file.gid), 'ascii');
    hash.update('\0');
    hash.update(String(body.length), 'ascii');
    hash.update('\0');
    hash.update(body);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function packageVersion(relative) {
  const value = JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)) fail('invalid_component_version');
  return value.version;
}

function installedPackageVersion(name) {
  const value = execFileSync('/usr/bin/dpkg-query', ['-W', '-f=${Version}', name], {
    encoding: 'utf8',
    maxBuffer: 4096,
    timeout: 5_000,
  }).trim();
  if (!/^\d+[A-Za-z0-9.+:~_-]*$/.test(value)) fail('invalid_os_package_version');
  return value;
}

function main(env = process.env) {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('invalid_runtime_platform');
  const sourceCommit = env.DISPATCH_SOURCE_COMMIT;
  const sourceState = env.DISPATCH_SOURCE_STATE;
  const chromiumVersion = env.DISPATCH_CHROMIUM_VERSION;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) fail('invalid_source_commit');
  if (!['clean', 'dirty'].includes(sourceState)) fail('invalid_source_state');
  if (!/^\d+[A-Za-z0-9.+:~_-]*$/.test(chromiumVersion || '')) fail('invalid_chromium_version');
  const osPackages = {
    caCertificates: installedPackageVersion('ca-certificates'),
    chromium: installedPackageVersion('chromium'),
    chromiumSandbox: installedPackageVersion('chromium-sandbox'),
    fontsLiberation: installedPackageVersion('fonts-liberation'),
    tini: installedPackageVersion('tini'),
    utilLinux: installedPackageVersion('util-linux'),
  };
  if (osPackages.chromium !== chromiumVersion || osPackages.chromiumSandbox !== chromiumVersion) {
    fail('chromium_version_mismatch');
  }
  const files = sourceFiles();
  const manifest = {
    schemaVersion: 1,
    sourceCommit,
    sourceState,
    baseImage: 'docker.io/library/node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96',
    platform: 'linux/amd64',
    nodeVersion: process.version,
    chromiumVersion,
    osPackages,
    protocols: {
      runtimeAgent: RUNTIME_AGENT_PROTOCOL_VERSION,
      runtimeGateway: RUNTIME_GATEWAY_PROTOCOL_VERSION,
    },
    components: {
      authBroker: packageVersion('runtime/auth-broker/package.json'),
      collectionManager: packageVersion('runtime/collection-manager/package.json'),
      runtimeAgent: packageVersion('runtime/agent/package.json'),
      runtimeContainer: packageVersion('runtime/supervisor/package.json'),
      runtimeGateway: packageVersion('runtime/gateway/package.json'),
      sdk: packageVersion('runtime/sdk/package.json'),
    },
    codeTreeDigest: treeDigest(files),
    sourceFileCount: files.length,
  };
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest)}\n`, { mode: 0o444, flag: 'wx' });
  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.code || 'runtime_manifest_failed'}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, sourceFiles, treeDigest };
