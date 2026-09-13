'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { privateDirectory } = require('../../controller/operations');
const { atomic } = require('../../../core/installations/src/release-delivery-files');
const { sealPackage } = require('../../../tooling/build-plugin-package');
const { distributePackage, approvePackages } = require('../distribution');
const { packageCatalog } = require('../../../core/plugins/package-catalog');

test('distribution verifies immutable versions, retains old packages and never installs a DSP implicitly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-distribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { local: privateDirectory(path.join(root, 'local')) };
  const make = (version, suffix = '') => {
    const directory = privateDirectory(path.join(root, 'package-' + version + suffix));
    privateDirectory(path.join(directory, 'backend'));
    atomic(path.join(directory, 'dispatch-plugin.json'), { ...require('../../../tests/fixtures/paycom-plugin.json'),
      version, frontend: null, dashboard: null, published: null, runtime: 'backend/index.js' });
    fs.writeFileSync(path.join(directory, 'backend/index.js'), 'module.exports = {};' + suffix, { mode: 0o600 });
    return { directory, digest: sealPackage(directory).digest };
  };
  const old = make('0.17.1'), current = make('0.17.2');
  await distributePackage(paths, old); await distributePackage(paths, current); await distributePackage(paths, old);
  assert.equal(packageCatalog(paths).resolve('paycom', '0.17.1').digest, old.digest);
  assert.equal(packageCatalog(paths).resolve('paycom', '0.17.2').digest, current.digest);
  assert.equal(packageCatalog(paths).latest('paycom'),null);
  await approvePackages(paths,{runtimeKey:'dev',packages:[{pluginId:'paycom',version:'0.17.2',digest:current.digest}]});
  assert.equal(packageCatalog(paths).latest('paycom','dev').version,'0.17.2');
  assert.equal(packageCatalog(paths).latest('paycom','other'),null);
  assert.throws(()=>packageCatalog(paths).resolveApproved('paycom','0.17.2','other'),/plugin_package_not_approved/);
  await distributePackage(paths,make('0.18.10'));await distributePackage(paths,make('0.18.9'));
  assert.equal(packageCatalog(paths).latest('paycom','dev').version,'0.17.2');
  assert.equal(packageCatalog(paths).latest('paycom'),null);
  assert.notEqual(fs.statSync(path.join(old.directory, 'backend/index.js')).ino,
    fs.statSync(path.join(packageCatalog(paths).resolve('paycom', '0.17.1').directory, 'backend/index.js')).ino);
  await assert.rejects(distributePackage(paths, make('0.17.2', '-changed')), /plugin_version_immutable/);
  assert.equal(fs.existsSync(path.join(root, 'dsps')), false);
});

test('future plugins can package a validated settings definition larger than the old manifest limit',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-large-settings-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const paths={local:privateDirectory(path.join(root,'local'))},directory=privateDirectory(path.join(root,'package'));
  privateDirectory(path.join(directory,'backend'));
  const fields=Array.from({length:40},(_,index)=>({id:'field_'+index,section:'general',label:'Configurable field '+index,description:'x'.repeat(400),type:'boolean',default:true}));
  atomic(path.join(directory,'dispatch-plugin.json'),{...require('../../../tests/fixtures/paycom-plugin.json'),frontend:null,dashboard:null,published:null,runtime:'backend/index.js',settings:{version:1,sections:[{id:'general',label:'General'}],fields}});
  fs.writeFileSync(path.join(directory,'backend/index.js'),'module.exports={};',{mode:0o600});
  assert.ok(fs.statSync(path.join(directory,'dispatch-plugin.json')).size>16384);
  const digest=sealPackage(directory).digest;await distributePackage(paths,{directory,digest});
  assert.equal(packageCatalog(paths).resolve('paycom',require('../../../tests/fixtures/paycom-plugin.json').version).manifest.plugin.settings.fields.length,40);
});

test('legacy approval is preserved before staging a new candidate', () => {
 const {normalizeCatalog}=require('../../../core/plugins/package-catalog');
 const old=normalizeCatalog({schemaVersion:1,items:[{pluginId:'paycom',version:'0.17.2',digest:'a'.repeat(64)}]});
 assert.equal(old.approved.production.paycom,'0.17.2');
 old.items.push({pluginId:'paycom',version:'0.18.0',digest:'b'.repeat(64)});
 assert.equal(normalizeCatalog(old).approved.production.paycom,'0.17.2');
});

test('an explicit DSP release catalog never falls back to global plugins, including an empty release', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plugin-approvals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { local: privateDirectory(path.join(root, 'local')) };
  await approvePackages(paths, { runtimeKey: 'empty', packages: [] });
  assert.equal(packageCatalog(paths).latest('paycom', 'empty'), null);
  const file = path.join(paths.local, 'config/plugin-packages.json');
  const value = JSON.parse(fs.readFileSync(file));
  value.items.push({ pluginId: 'paycom', version: '1.0.0', digest: 'a'.repeat(64) });
  value.approved.production.paycom = '1.0.0';
  value.approved.dsps.selected = { paycom: '1.0.0' };
  atomic(file, value);
  assert.equal(packageCatalog(paths).latest('paycom', 'legacy').version, '1.0.0');
  assert.equal(packageCatalog(paths).latest('paycom', 'selected').version, '1.0.0');
  assert.equal(packageCatalog(paths).latest('paycom', 'empty'), null);
  await approvePackages(paths, { runtimeKey: 'selected', packages: [] });
  assert.equal(packageCatalog(paths).latest('paycom', 'selected'), null);
  assert.throws(() => packageCatalog(paths).resolveApproved('paycom', '1.0.0', 'selected'), /plugin_package_not_approved/);
});
