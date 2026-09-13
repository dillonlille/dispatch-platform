'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CollectionStore}=require('dispatch-runtime-kit/collection-manager/src/store');
const {collectorEnabled,applyState}=require('dispatch-runtime-kit/collection-manager/src/plugin-state');
test('concurrent DSP databases use their own installed declarations during a mixed-version rollout',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-metadata-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stores=['old','new'].map((collector,index)=>{
  const manifest={...require('../../../tests/fixtures/paycom-plugin.json'),version:`1.${index}.0`,collectors:[collector],syncs:[]};
  const databaseRoot=path.join(root,collector),store=new CollectionStore({databaseRoot,database:path.join(databaseRoot,'collections.sqlite3')},{plugins:[manifest]});
  t.after(()=>store.close());return store;
 });
 assert.equal(collectorEnabled(stores[0].db,'old'),false);assert.equal(collectorEnabled(stores[1].db,'new'),false);
 applyState(stores[0],{command:'apply',pluginId:'paycom',version:'1.0.0',revision:1,state:'enabled'});
 assert.equal(collectorEnabled(stores[0].db,'old'),true);assert.equal(collectorEnabled(stores[1].db,'new'),false);
 assert.equal(stores[1].db.prepare('SELECT version FROM plugin_installations').get().version,'1.1.0');
});
