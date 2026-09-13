'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const test = require('node:test'), assert = require('node:assert/strict');
const { capture, verify, materialize } = require('../src/recovery-capsule');
test('live SQLite WAL pages are captured without transient sidecars', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-capsule-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const { DatabaseSync } = require('node:sqlite'), live = new DatabaseSync(path.join(source, 'state.sqlite3'));
  t.after(() => live.close());
  live.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value); INSERT INTO records VALUES('committed in WAL')");
  const directory = path.join(root, 'bundle'), target = '/opt/dispatch-fixture';
  const proof = capture(directory, [{ source, target }], {}, new Set([process.geteuid()]));
  const manifest = verify(directory, proof.sha256, new Set([target]));
  assert.equal(manifest.entries.some(e => /-(wal|shm)$/.test(e.path)), false);
  const file = manifest.entries.find(e => e.path.endsWith('.sqlite3'));
  const restored = new DatabaseSync(path.join(directory, file.payload), { readOnly: true });
  try { assert.equal(restored.prepare('SELECT value FROM records').get().value, 'committed in WAL'); }
  finally { restored.close(); }
});
test('recovery capsule preserves code, secrets and configuration with authenticated ownership metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-capsule-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'server'), 'exact executable', { mode: 0o555 });
  fs.writeFileSync(path.join(source, 'vault-key'), 'fixture encryption key', { mode: 0o600 });
  fs.symlinkSync('server', path.join(source, 'current'));
  const bundle = path.join(root, 'bundle'), target = '/opt/dispatch-fixture';
  const proof = capture(bundle, [{ source, target }], { kind: 'core', releaseId: 'dispatch_fixture' }, new Set([process.geteuid()]));
  const allowed = new Set([target]), inventory = verify(bundle, proof.sha256, allowed);
  assert.equal(inventory.entries.find(e => e.path.endsWith('/server')).mode, 0o555);
  const staging = path.join(root, 'restored'); materialize(bundle, staging, proof.sha256, allowed);
  assert.equal(fs.readFileSync(path.join(staging, target, 'vault-key'), 'utf8'), 'fixture encryption key');
  assert.equal(fs.readFileSync(path.join(staging, target, 'current'), 'utf8'), 'exact executable');
  const payload = inventory.entries.find(e => e.path.endsWith('/vault-key')).payload;
  fs.writeFileSync(path.join(bundle, payload), 'changed');
  assert.throws(() => verify(bundle, proof.sha256, allowed), /recovery_capsule_invalid/);
});
test('recovery refuses links escaping the approved restore roots and forged target roots', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-capsule-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  fs.symlinkSync('/etc/passwd', path.join(source, 'escape'));
  const bundle = path.join(root, 'bundle'), target = '/opt/dispatch-fixture';
  const proof = capture(bundle, [{ source, target }], {}, new Set([process.geteuid()]));
  assert.throws(() => verify(bundle, proof.sha256, new Set([target])), /recovery_capsule_invalid/);
  assert.throws(() => materialize(bundle, path.join(root, 'restored'), proof.sha256, new Set(['/etc'])), /recovery_capsule_invalid/);
  assert.equal(fs.existsSync(path.join(root, 'restored')), false);
});
test('sealed DSP snapshot overrides retain their exact tree while SQLite is captured', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-capsule-sealed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const liveRoot = path.join(root, 'live'), snapshot = path.join(root, 'snapshot');
  fs.mkdirSync(liveRoot); fs.mkdirSync(snapshot);
  const { DatabaseSync } = require('node:sqlite');
  const original = new DatabaseSync(path.join(liveRoot, 'data.sqlite3'));
  original.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value); INSERT INTO records VALUES('sealed')");
  original.close();
  fs.copyFileSync(path.join(liveRoot, 'data.sqlite3'), path.join(snapshot, 'data.sqlite3'));
  const before = fs.readFileSync(path.join(snapshot, 'data.sqlite3'));
  const bundle = path.join(root, 'bundle'), target = '/opt/dispatch-fixture';
  const proof = capture(bundle, [{ source: liveRoot, target, overrides: { 'data.sqlite3': path.join(snapshot, 'data.sqlite3') } }], {}, new Set([process.geteuid()]));
  assert.deepEqual(fs.readdirSync(snapshot), ['data.sqlite3']);
  assert.deepEqual(fs.readFileSync(path.join(snapshot, 'data.sqlite3')), before);
  const manifest = verify(bundle, proof.sha256, new Set([target]));
  const file = manifest.entries.find(e => e.path.endsWith('.sqlite3'));
  const restored = new DatabaseSync(path.join(bundle, file.payload), { readOnly: true });
  try { assert.equal(restored.prepare('SELECT value FROM records').get().value, 'sealed'); }
  finally { restored.close(); }
});

test('a DSP stopped for backup resumes its captured ready state during disaster recovery',()=>{
 const {servicesForRecovery}=require('../src/host-recovery-bundle'),{opaqueRuntimeSuffix}=require('../../runtime-host-identity');
 const runtime='runtime_fixture',name=`dispatch-dsp-${opaqueRuntimeSuffix(runtime)}.service`,services=[{name,active:false,enabled:true}],installations=[{runtime_key:runtime,status:'ready',organization_status:'active'}];
 assert.equal(servicesForRecovery('dsp',services,installations)[0].active,true);assert.equal(services[0].active,false);
 assert.equal(servicesForRecovery('core',services,installations)[0].active,false);
 assert.equal(servicesForRecovery('dsp',services,[{...installations[0],status:'suspended'}])[0].active,false);
});
test('a DSP recovery capsule permits only its own Core-side registration credential',()=>{
 const {recoveryRoots}=require('../src/host-recovery-bundle'),{hostAccountName,opaqueRuntimeSuffix,HOST_TENANT_ROOT}=require('../../runtime-host-identity');
 const key='runtime_fixture',root=HOST_TENANT_ROOT+'/'+opaqueRuntimeSuffix(key),localRoot='/home/core_fixture/local';
 const metadata={kind:'dsp',platform:'ubuntu-24.04-amd64',localRoot,services:[],accounts:[{name:'core_fixture',uid:1001,gid:1001,home:'/home/core_fixture'},{name:hostAccountName(key),uid:20001,gid:20001,home:root+'/home'}],installations:[{organization_id:'org_fixture',runtime_key:key,backend:'native_service_v1',status:'ready'}]};
 const token=localRoot+'/secrets/oci-runtime-agents/'+key+'.token';assert.ok(recoveryRoots(metadata,[token]).has(token));
 assert.throws(()=>recoveryRoots(metadata,[localRoot+'/secrets/oci-runtime-agents/runtime_peer.token']),/host_recovery_unavailable/);
});
