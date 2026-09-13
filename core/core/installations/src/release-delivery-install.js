'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bundle, sha, fail, identity } = require('./release-delivery-contract');
const { rootParents, atomic, hashFile, hashFileSync } = require('./release-delivery-files');
const { finishCoreArtifact } = require('./core-artifact-layout');
const { verifyCoreArtifact } = require('./platform-core-update');
const { verifyPreparedHostArtifact } = require('./oci-host-artifact');
function writeBundle(value, root) {
  for (const item of value.files) {
    const file = path.join(root, item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, Buffer.from(item.data, 'base64'), { mode: parseInt(item.mode, 8), flag: 'wx' });
  }
}
function tree(root) {
  const files = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('unsafe_release_storage');
      if (stat.isDirectory()) visit(file);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) fail('unsafe_release_storage');
        files.push({ path: path.relative(root, file), mode: stat.mode & 0o7777, hash: hashFileSync(file) });
      }
    }
  }
  visit(root); return files;
}
function seal(root) {
  for (const name of fs.readdirSync(root)) { const file = path.join(root, name); if (fs.lstatSync(file).isDirectory()) seal(file); }
  fs.chmodSync(root, 0o555);
}
function removeStage(root) {
  if (!fs.existsSync(root)) return;
  function writable(dir) { fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.lstatSync(file).isDirectory()) writable(file); } }
  writable(root); fs.rmSync(root, { recursive: true });
}
function installTree(source, target) {
  rootParents(path.dirname(target));
  if (fs.existsSync(target)) {
    rootParents(target);
    if (JSON.stringify(tree(source)) !== JSON.stringify(tree(target))) fail('immutable_release_conflict');
    return;
  }
  const temporary = `${target}.pending`;
  // A prior interruption can leave only this daemon-owned preparation directory.
  if (fs.existsSync(temporary)) { rootParents(temporary); removeStage(temporary); }
  fs.cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });
  seal(temporary); fs.renameSync(temporary, target);
  const fd=fs.openSync(path.dirname(target),'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function prepareRelease({ config, manifest, directory, publishedAt, configureSandbox = installBrowserSandboxProfile }) {
  if (process.geteuid() !== 0) fail('release_installer_requires_root');
  const id = identity(manifest.version, manifest.sourceCommit);
  const stage = path.join(directory, 'prepared');
  let packages = null;
  try {
  packages = manifest.schemaVersion === 2 ? require('./release-package').preparePackages(directory, manifest) : null;
  const core = packages?.core || bundle(JSON.parse(fs.readFileSync(path.join(directory, manifest.assets.core.name))), 'core', manifest.sourceCommit);
  const bridge = packages?.bridge || bundle(JSON.parse(fs.readFileSync(path.join(directory, manifest.assets.bridge.name))), 'bridge', manifest.sourceCommit);
  const bridgeManifest = bridge.files.find(item => item.path === 'bridge-artifact/manifest.json');
  if (!bridgeManifest || sha(Buffer.from(bridgeManifest.data, 'base64')) !== manifest.runtime.bridgeManifestSha256) fail('release_checksum_failed');
  removeStage(stage); fs.mkdirSync(stage, { mode: 0o700 });
    const coreRoot=path.join(stage,'core'); fs.mkdirSync(coreRoot); writeBundle(core, coreRoot);
    const platformRoot=path.join(stage,'platform'); fs.mkdirSync(platformRoot);
    const artifact=path.join(platformRoot,'core-artifact'); fs.mkdirSync(artifact);
    fs.renameSync(path.join(coreRoot,'code'), path.join(artifact,'code'));
    const helperRoot=path.join(coreRoot,'host-helper-artifact');
    const helperHash=sha(fs.readFileSync(path.join(helperRoot,'manifest.json')));
    const deployment={releaseId:id,version:manifest.version,sourceCommit:manifest.sourceCommit,helperManifestSha256:helperHash,
      localRoot:config.localRoot,unitRoot:config.unitRoot,publicOrigin:config.publicOrigin,port:config.port};
    const coreHash=finishCoreArtifact(artifact,deployment);
    const runtimeRoot=path.join(stage,'runtime'); fs.mkdirSync(runtimeRoot); writeBundle(bridge,runtimeRoot);
    const native = manifest.runtime.backend === 'native_service_v1';
    if (packages) {
      fs.renameSync(packages.runtime, path.join(runtimeRoot, 'runtime-artifact'));
    } else if (native) {
      require('./native-runtime-artifact').unpackNativeRuntime(path.join(directory, manifest.assets.runtime.name),
        path.join(runtimeRoot, 'runtime-artifact'), manifest.runtime);
    } else {
      fs.copyFileSync(path.join(directory,manifest.assets.runtime.name),path.join(runtimeRoot,'runtime-image.tar'));
      fs.chownSync(path.join(runtimeRoot,'runtime-image.tar'),0,0);
      fs.chmodSync(path.join(runtimeRoot,'runtime-image.tar'),0o444);
    }
    seal(coreRoot); seal(platformRoot); seal(runtimeRoot);
    rootParents('/opt');
    for(const base of ['/opt/dispatch-platform/releases','/opt/dispatch-control/releases','/opt/dispatch-runtime/releases']) {
      fs.mkdirSync(base,{recursive:true,mode:0o755}); rootParents(base);
    }
    installTree(platformRoot,`/opt/dispatch-platform/releases/${id}`);
    installTree(coreRoot,`/opt/dispatch-control/releases/${id}`);
    installTree(runtimeRoot,`/opt/dispatch-runtime/releases/${id}`);
    const release={version:manifest.version,publishedAt,sourceCommit:manifest.sourceCommit,runtimeImageDigest:manifest.runtime.imageDigest || `sha256:${manifest.runtime.artifactSha256}`,
      changelog:manifest.changelog,core:{artifactPath:`/opt/dispatch-platform/releases/${id}/core-artifact`,manifestSha256:coreHash}};
    verifyCoreArtifact(id,release);
    verifyPreparedHostArtifact(`/opt/dispatch-control/releases/${id}/host-helper-artifact/core/installations/bin/dispatch-oci-host-issuer`,id,helperHash,'dispatch-oci-host-issuer');
    if (native) require('./native-runtime-artifact').verifyNativeRuntime(`/opt/dispatch-runtime/releases/${id}/runtime-artifact`, manifest.runtime);
    else if(await hashFile(`/opt/dispatch-runtime/releases/${id}/runtime-image.tar`)!==manifest.runtime.imageArchiveSha256)fail('release_checksum_failed');
    if (native) configureSandbox();
    // The bootstrap installs this daemon once; it grants only this verified release's fixed, argument-free switch command.
    const command=`/opt/dispatch-platform/releases/${id}/core-artifact/switch-host`;
    const policy=[command, `/opt/dispatch-platform/releases/${id}/core-artifact/prepare-backup`].map(selected =>
      `Defaults!${selected} env_reset,!setenv,secure_path="/usr/bin:/bin"\nDefaults!${selected} env_delete += "NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH"\n#${config.uid} ALL=(root) NOPASSWD: NOSETENV: ${selected} ""\n`).join('');
    rootParents('/etc/sudoers.d');
    const sudoFile=`/etc/sudoers.d/dispatch-release-${id.slice('dispatch_'.length).replaceAll('.','_')}`;
    const check=path.join(directory,'sudoers-check'); atomic(check,policy,0o440);
    const checked=spawnSync('/usr/sbin/visudo',['-cf',check],{encoding:'utf8'});
    if(checked.status!==0)fail('release_permissions_failed');
    if(fs.existsSync(sudoFile)&&fs.readFileSync(sudoFile,'utf8')!==policy)fail('immutable_release_conflict');
    if(!fs.existsSync(sudoFile))atomic(sudoFile,policy,0o440);
    return release;
  } finally { removeStage(stage); if (packages) removeStage(packages.stage); }
}
function installBrowserSandboxProfile() {
  if (!fs.existsSync('/sys/module/apparmor')) return;
  rootParents('/etc/apparmor.d');
  // Chromium still runs its own user-namespace and seccomp sandbox. This named
  // profile permits that namespace on Ubuntu hosts restricting unconfined userns.
  const profile = 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile dispatch-native-chrome /opt/{dispatch/dependencies/browser,dispatch-runtime/releases/*/runtime-artifact/dependencies/browser}/chrome flags=(unconfined) {\n  userns,\n}\n';
  const file = '/etc/apparmor.d/dispatch-native-chrome';
  atomic(file, profile, 0o644);
  const result = spawnSync('/usr/sbin/apparmor_parser', ['-r', file], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4096 });
  if (result.error || result.status !== 0) fail('browser_sandbox_unavailable');
}
module.exports = { prepareRelease, writeBundle, installTree, removeStage, tree, seal, installBrowserSandboxProfile };
