'use strict';
const path = require('node:path');
const { privateJson } = require('../installations/src/release-delivery-files');
const { SHA256 } = require('../../shared/plugin-sdk/package');
const { verifyPackage } = require('../../shared/plugin-sdk/package-files');
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const compare = (a, b) => { const x=a.version.split('.').map(Number),y=b.version.split('.').map(Number); return x[0]-y[0]||x[1]-y[1]||x[2]-y[2]; };
function normalizeCatalog(value) {
  const fail = () => { throw new Error('plugin_catalog_invalid'); };
  if (Buffer.byteLength(JSON.stringify(value)||'')>256*1024)fail();
  if (!value || ![1,2].includes(value.schemaVersion) || Object.keys(value).sort().join(',') !== (value.schemaVersion === 1 ? 'items,schemaVersion' : 'approved,items,schemaVersion')
      || !Array.isArray(value.items) || value.items.length > 1024) fail();
  const entries = new Map();
  for (const item of value.items) {
    if (!item || Object.keys(item).sort().join(',') !== 'digest,pluginId,version' || !ID.test(item.pluginId)
        || !VERSION.test(item.version) || !SHA256.test(item.digest) || entries.has(`${item.pluginId}@${item.version}`)) fail();
    entries.set(`${item.pluginId}@${item.version}`, item);
  }
  // A legacy catalog was already active. Preserve that decision before staging
  // a new candidate; never implicitly approve a newly downloaded version.
  if (value.schemaVersion === 1) {
    const production = Object.fromEntries([...entries.values()].sort(compare).map(item => [item.pluginId,item.version]));
    value = { schemaVersion:2, items:value.items, approved:{production,dsps:{}} };
  }
  const approved=value.approved;
  if (!approved || Object.keys(approved).sort().join(',') !== 'dsps,production') fail();
  const mapping = map => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail();
    for (const [id, version] of Object.entries(map)) if (!ID.test(id) || !VERSION.test(version) || !entries.has(`${id}@${version}`)) fail();
  };
  mapping(approved.production);
  if (!approved.dsps || typeof approved.dsps !== 'object' || Array.isArray(approved.dsps) || Object.keys(approved.dsps).length > 10000) fail();
  for (const [id,map] of Object.entries(approved.dsps)) { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) fail(); mapping(map); }
  return value;
}
function packageCatalog({ local }) {
  const raw = privateJson(path.join(local,'config/plugin-packages.json'),process.geteuid(),true);
  if (!raw) return null;
  const value=normalizeCatalog(raw),entries=new Map(value.items.map(item=>[`${item.pluginId}@${item.version}`,item]));
  const latest = (id,runtimeKey) => {
    const approved = runtimeKey && Object.hasOwn(value.approved.dsps, runtimeKey)
      ? value.approved.dsps[runtimeKey] : value.approved.production;
    const version = approved[id];
    return version ? entries.get(`${id}@${version}`) : null;
  };
  const resolve = (id,version) => {
    const item=entries.get(`${id}@${version}`);
    if (!item) throw new Error('plugin_package_unavailable');
    const directory=path.join(local,'packages/plugins',id,version),manifest=verifyPackage(directory,item.digest);
    if (manifest.plugin.id!==id || manifest.plugin.version!==version) throw new Error('plugin_catalog_invalid');
    return {directory,digest:item.digest,manifest};
  };
  return Object.freeze({ latest, resolve,
    resolveApproved(id,version,runtimeKey) {
      if (latest(id,runtimeKey)?.version !== version) throw new Error('plugin_package_not_approved');
      return resolve(id,version);
    },
    definitions() {
      const selected=new Map();
      for (const map of [value.approved.production,...Object.values(value.approved.dsps)]) for (const [id,version] of Object.entries(map)) {
        const prior=selected.get(id);
        if (!prior || compare({version},prior)>0) selected.set(id,resolve(id,version).manifest.plugin);
      }
      return [...selected.values()];
    },
  });
}
module.exports = { packageCatalog, normalizeCatalog };
