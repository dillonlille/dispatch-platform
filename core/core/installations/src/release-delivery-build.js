'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {PROJECT_ROOT}=require('../../../shared/paths/runtime-paths');
const {sha,bundle,identity,releaseManifest}=require('./release-delivery-contract');
const {hashFile}=require('./release-delivery-files');
const {authoring, markdown}=require('./release-notes');
const {removeStage}=require('./release-delivery-install');
const formats = require('./release-formats');
const legacy = formats.format('legacy'), split = formats.format('split');
function command(executable,args,options={}) {
  const result=spawnSync(executable,args,{cwd:PROJECT_ROOT,encoding:'utf8',timeout:600_000,maxBuffer:32*1024*1024,...options});
  if(result.status!==0||result.error) {
    // Build logs contain tool diagnostics; credentials are supplied only to the later publication step.
    if(result.stderr)process.stderr.write(result.stderr.toString().slice(-8192));
    throw new Error(`release_build_command_failed:${path.basename(executable)}:${args.find(arg=>['load','save','run','rm','unshare','inspect','tag'].includes(arg))||'source'}`);
  }
  return result.stdout;
}
function portableCore(output, popup = null) {
  if(command('/usr/bin/git',['status','--porcelain']).trim())throw Error('clean_checkout_required');
  const commit=command('/usr/bin/git',['rev-parse','HEAD']).trim();
  const files=[];
  for(const row of command('/usr/bin/git',['ls-tree','-r','-z','HEAD']).split('\0').filter(Boolean)) {
    const match=/^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(row);if(!match)throw Error('unsupported_git_entry');
    const [,mode,object,relative]=match;
    if(!(/^(core|dashboard|protocol)\//.test(relative)||['bin/dispatch-dashboard','bin/dispatch-access-admin'].includes(relative))
      ||/\/(tests|examples|docs)\//.test(relative))continue;
    if(!['100644','100755'].includes(mode))throw Error('unsupported_git_mode');
    const data=Buffer.from(command('/usr/bin/git',['cat-file','blob',object],{encoding:null}));
    files.push({path:`code/${relative}`,mode:mode==='100755'?'555':'444',sha256:sha(data),data:data.toString('base64')});
  }
  files.push(...require('./release-frontend').buildFrontend(PROJECT_ROOT, commit, path.dirname(output)));
  if(popup) {
    require('../../accounts/src/release-popup').validatePopup(popup,{releaseId:popup.releaseId,version:popup.version,sourceCommit:commit});
    const data=Buffer.from(JSON.stringify(popup)+'\n');
    const relative='code/dashboard/release-popup.json';
    if(files.some(file=>file.path===relative))throw Error('reserved_release_popup_file');
    files.push({path:relative,mode:'444',sha256:sha(data),data:data.toString('base64')});
  }
  const temporary=fs.mkdtempSync(path.join(path.dirname(output),'helper-build-'));
  try {
    require('./create-host-helper-artifact').main([path.join(temporary,'host-helper-artifact')]);
    collect(temporary,'host-helper-artifact',files);
  } finally {removeStage(temporary);}
  const value=bundle({schemaVersion:1,kind:'core',sourceCommit:commit,files},'core',commit);
  fs.writeFileSync(output,JSON.stringify(value)+'\n',{flag:'wx',mode:0o644});return commit;
}
function collect(root,relative,files) {
  const file=path.join(root,relative),stat=fs.lstatSync(file);
  if(stat.isDirectory())for(const name of fs.readdirSync(file).sort())collect(root,path.join(relative,name),files);
  else {
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('unsafe_bundle_file');
    const data=fs.readFileSync(file);files.push({path:relative,mode:stat.mode&0o111?'555':'444',sha256:sha(data),data:data.toString('base64')});
  }
}
// Both formats share one source snapshot and one native dependency inventory.
async function build(version, notesFile, output, format = 'legacy', preparedDirectory = null) {
  if (format !== 'both') formats.format(format);
  if (format === 'both' && preparedDirectory) throw Error('both_formats_cannot_reuse');
  const started = Date.now();
  process.umask(0o022);
  if (!path.isAbsolute(output) || path.resolve(output) !== output || output === PROJECT_ROOT || output.startsWith(PROJECT_ROOT + '/') || fs.existsSync(output)) throw Error('invalid_output');
  if (command('/usr/bin/git', ['status', '--porcelain']).trim()) throw Error('clean_checkout_required');
  const commit = command('/usr/bin/git', ['rev-parse', 'HEAD']).trim(), id = identity(version, commit);
  const authored = authoring(JSON.parse(fs.readFileSync(notesFile, 'utf8')));
  const popup = authored.popup ? {schemaVersion:1, releaseId:id, version, sourceCommit:commit, ...authored.popup} : null;
  const names = format === 'both' ? ['legacy', 'split'] : [format];
  require('./release-build-space').preflight(output, {format, preparedDirectory});
  return require('./release-build-space').withOutput(output, async () => {
    const directories = Object.fromEntries(names.map(name => [name, format === 'both' ? path.join(output, name) : output]));
    if (format === 'both') for (const directory of Object.values(directories)) fs.mkdirSync(directory, {mode:0o700});
    const parts = {};
    if (preparedDirectory) {
      parts[format] = await reuseComponents(preparedDirectory, output, commit, popup, format);
    } else {
      const base = directories.legacy || directories.split;
      portableCore(path.join(base, legacy.assets.core), popup);
      const bridgeRoot = path.join(output, 'bridge-build'); fs.mkdirSync(bridgeRoot);
      require('./create-bridge-artifact').main([path.join(bridgeRoot, 'bridge-artifact')]);
      const files = []; collect(bridgeRoot, 'bridge-artifact', files);
      fs.writeFileSync(path.join(base, legacy.assets.bridge), JSON.stringify(bundle({schemaVersion:1, kind:'bridge', sourceCommit:commit, files}, 'bridge', commit)) + '\n');
      const bridgeHash = sha(fs.readFileSync(path.join(bridgeRoot, 'bridge-artifact/manifest.json'))); removeStage(bridgeRoot);
      const dependencies = directories.split ? require('./release-dependencies').verify() : null;
      const native = require('./native-runtime-build');
      native.buildNativeRuntime({projectRoot:PROJECT_ROOT, archive:path.join(base, legacy.assets.runtime), sourceCommit:commit,
        consumeStage(stage, embeddedManifestSha256) {
          if (directories.legacy) parts.legacy = {bridgeHash, artifact: {
            embeddedManifestSha256, artifactSha256:native.packNativeRuntime(stage, path.join(base, legacy.assets.runtime))}};
          if (directories.split) parts.split = {bridgeHash, dependencies, ...splitStage(stage, embeddedManifestSha256, base, directories.split, commit)};
        }});
      if (!directories.legacy) for (const kind of ['core', 'bridge']) fs.unlinkSync(path.join(base, legacy.assets[kind]));
    }
    const results = {};
    for (const name of names) results[name] = await finish(version, commit, id, authored, directories[name], name, parts[name], started);
    if (format === 'both') fs.writeFileSync(path.join(output, 'build-metrics.json'), JSON.stringify({durationMs:Date.now()-started, format, nativeBuildCount:1}) + '\n');
    return format === 'both' ? {version, sourceCommit:commit, formats:results} : results[format];
  });
}
function splitStage(stage, embeddedManifestSha256, base, output, commit) {
  const packageRoot = path.join(output, 'package-build'); fs.mkdirSync(packageRoot);
  try {
    const appRoot = path.join(packageRoot, 'app'), dependencyRoot = path.join(packageRoot, 'dependencies');
    fs.mkdirSync(appRoot); fs.mkdirSync(dependencyRoot);
    for (const kind of ['core', 'bridge']) {
      const root = path.join(appRoot, kind); fs.mkdirSync(root);
      require('./release-delivery-install').writeBundle(JSON.parse(fs.readFileSync(path.join(base, legacy.assets[kind]))), root);
    }
    fs.renameSync(path.join(stage, 'dependencies'), path.join(dependencyRoot, 'dependencies'));
    fs.renameSync(stage, path.join(appRoot, 'runtime'));
    const {pack, runtimeIdentity} = require('./release-package');
    const assets = {
      app:pack(appRoot, path.join(output, split.assets.app), 'app', commit),
      dependencies:pack(dependencyRoot, path.join(output, split.assets.dependencies), 'dependencies'),
    };
    return {assets, artifact:{embeddedManifestSha256, artifactSha256:runtimeIdentity(assets)}};
  } finally { removeStage(packageRoot); }
}
async function finish(version, commit, id, authored, output, format, parts, started) {
  const selected = formats.format(format), {changelog:notes, notes:presentation, github} = authored;
  const {artifact, bridgeHash, dependencies = null} = parts, assets = parts.assets || {};
  const runtime = {version:1, backend:'native_service_v1', releaseId:id, channel:'production', sourceCommit:commit,
    platform:'linux/amd64', runtimeAgentProtocol:1, runtimeGatewayProtocol:1, ...artifact, bridgeManifestSha256:bridgeHash};
  if (format === 'legacy') for (const [key, name] of Object.entries(selected.assets)) {
    const file = path.join(output, name); assets[key] = {name, size:fs.statSync(file).size, sha256:await hashFile(file)};
  }
  const richNotes = presentation ? {schemaVersion:1, releaseId:id, sourceCommit:commit, ...presentation} : null;
  const manifest = releaseManifest({schemaVersion:selected.schemaVersion, version, releaseId:id, sourceCommit:commit, changelog:notes, assets, runtime,
    ...(format === 'split' ? {notes:richNotes, dependencies} : {})});
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 256*1024) throw Error('release_manifest_too_large');
  fs.writeFileSync(path.join(output, formats.manifest), bytes);
  if (selected.notesSidecar && richNotes) fs.writeFileSync(path.join(output, formats.notes), JSON.stringify(richNotes, null, 2) + '\n');
  fs.writeFileSync(path.join(output, formats.changelog), markdown(version, notes, presentation, github));
  if (selected.checksums) {
    const sums = [];
    for (const name of [...Object.values(assets).map(a => a.name), formats.manifest, ...(richNotes ? [formats.notes] : [])]) sums.push(`${await hashFile(path.join(output, name))}  ${name}`);
    fs.writeFileSync(path.join(output, selected.checksums), sums.join('\n') + '\n');
  }
  fs.writeFileSync(path.join(output, 'build-metrics.json'), JSON.stringify({durationMs:Date.now()-started, format, assets}) + '\n');
  return manifest;
}
async function reuseComponents(directory, output, commit, popup, format = 'legacy') {
  const manifest = releaseManifest(JSON.parse(fs.readFileSync(path.join(directory, formats.manifest))));
  if (manifest.sourceCommit !== commit || manifest.runtime.backend !== 'native_service_v1') throw Error('verified_source_mismatch');
  if (manifest.schemaVersion !== formats.format(format).schemaVersion) throw Error('verified_format_mismatch');
  for (const asset of Object.values(manifest.assets)) {
    const file = path.join(directory, asset.name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size || await hashFile(file) !== asset.sha256)
      throw Error('verified_asset_mismatch');
  }
  if (format === 'split') return require('./release-reuse-split').reuse(directory, output, manifest, popup);
  const core = bundle(JSON.parse(fs.readFileSync(path.join(directory, legacy.assets.core))), 'core', commit);
  bundle(JSON.parse(fs.readFileSync(path.join(directory, legacy.assets.bridge))), 'bridge', commit);
  core.files = core.files.filter(file => file.path !== 'code/dashboard/release-popup.json');
  if (popup) {
    require('../../accounts/src/release-popup').validatePopup(popup, {releaseId: popup.releaseId, version: popup.version, sourceCommit: commit});
    const bytes = Buffer.from(JSON.stringify(popup) + '\n');
    core.files.push({path:'code/dashboard/release-popup.json', mode:'444', sha256:sha(bytes), data:bytes.toString('base64')});
  }
  bundle(core, 'core', commit);
  fs.writeFileSync(path.join(output, legacy.assets.core), JSON.stringify(core) + '\n', {flag:'wx'});
  for (const name of [legacy.assets.bridge, legacy.assets.runtime]) fs.copyFileSync(path.join(directory, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
  return {artifact: {artifactSha256: manifest.runtime.artifactSha256, embeddedManifestSha256: manifest.runtime.embeddedManifestSha256},
    bridgeHash: manifest.runtime.bridgeManifestSha256};
}
module.exports={build,portableCore,command,collect,reuseComponents};
