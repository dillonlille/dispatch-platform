'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = require('../paths/source-root').sourceRoot();
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const STATES = Object.freeze(['enabled', 'disabled', 'uninstalled']);
function fail() { throw Object.assign(new Error('plugin_definition_invalid'), { code: 'plugin_definition_invalid' }); }
function plain(value) { return value && Object.getPrototypeOf(value) === Object.prototype; }
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail(); return value; }
function exact(value, keys) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function strings(values, check = value => ID.test(value)) {
  if (!Array.isArray(values) || values.length > 64 || values.some(value => typeof value !== 'string' || !check(value))
      || new Set(values).size !== values.length) fail();
  return Object.freeze([...values]);
}
function validateManifest(value) {
  exact(value, ['schemaVersion', 'id', 'name', 'version', 'description', 'frontend', 'dashboard', 'runtime',
    'pages', 'actions', 'httpPrefixes', 'gatewayActions', 'services', 'collectors', 'syncs', 'legacyProfile',
    ...(Object.hasOwn(value || {}, 'published') ? ['published'] : []),
    ...(Object.hasOwn(value || {}, 'jobs') ? ['jobs'] : []),
    ...(Object.hasOwn(value || {}, 'settings') ? ['settings'] : []),
    ...(Object.hasOwn(value || {}, 'package') ? ['package'] : [])]);
  if (value.schemaVersion !== 1 || !VERSION.test(value.version)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80
      || typeof value.description !== 'string' || value.description.length > 500) fail();
  identifier(value.id);
  for (const field of ['frontend', 'dashboard', 'runtime', ...(Object.hasOwn(value, 'published') ? ['published'] : [])]) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !/^[a-z][a-z0-9/-]*\.(js|tsx)$/.test(value[field])
        || value[field].split('/').includes('..'))) fail();
  }
  if (!Array.isArray(value.pages) || value.pages.length > 16) fail();
  const pages = value.pages.map(page => {
    exact(page, ['id', 'label', 'icon', 'permission']); identifier(page.id);
    if (typeof page.label !== 'string' || !page.label.trim() || page.label.length > 80
        || !['calendar', 'puzzle'].includes(page.icon) || !/^[a-z][a-z.]{0,63}$/.test(page.permission)) fail();
    return Object.freeze({ ...page });
  });
  if (!Array.isArray(value.actions) || value.actions.length > 64) fail();
  const actions = value.actions.map(action => Object.freeze(require('dispatch-sdk/operations').validateOperation(action)));
  if (new Set(actions.map(action => action.id)).size !== actions.length) fail();
  if (value.package !== undefined) {
    exact(value.package, ['runtime', 'authentication', 'collections']);
    for (const [key, entry] of Object.entries(value.package)) {
      if (entry === null && key !== 'runtime') continue;
      if (typeof entry !== 'string' || !/^[a-z][a-z0-9/-]*\.(js|json)$/.test(entry)
          || (key === 'collections') !== entry.endsWith('.json')) fail();
    }
    value = { ...value, package: Object.freeze({ ...value.package }) };
  }
  if (value.legacyProfile !== null) identifier(value.legacyProfile);
  if (Object.hasOwn(value, 'settings')) {
    value = { ...value, settings: require('dispatch-sdk/settings').validateSettingsDefinition(value.settings) };
    if (value.settings.schedule && !value.syncs.includes(value.settings.schedule.id)) fail();
  }
  return Object.freeze({ ...value, pages: Object.freeze(pages), actions: Object.freeze(actions),
    httpPrefixes: strings(value.httpPrefixes, item => /^\/api\/[a-z][a-z0-9-]*$/.test(item)),
    gatewayActions: strings(value.gatewayActions, item => /^[a-z][a-z0-9_.]{0,63}$/.test(item)),
    services: strings(value.services), collectors: strings(value.collectors), syncs: strings(value.syncs),
    ...(Object.hasOwn(value, 'jobs') ? { jobs: strings(value.jobs) } : {}) });
}
function pluginEntry(root, plugin, field) {
  const relative = plugin[field];
  if (relative === null) return null;
  const base = path.join(root, 'plugins', plugin.id);
  const target = path.join(base, relative);
  // Only administrator-installed source is discovered. Private DSP paths and
  // request-supplied entrypoints never participate in loading executable code.
  if (fs.realpathSync(target) !== target || !fs.lstatSync(target).isFile()
      || !target.startsWith(base + '/')) fail();
  return target;
}
function loadCatalog(root = ROOT) {
  const directory = path.join(root, 'plugins');
  const plugins = [];
  if (!fs.existsSync(directory)) return Object.freeze(plugins);
  for (const name of fs.readdirSync(directory).sort()) {
    const folder = path.join(directory, name);
    if (!fs.lstatSync(folder).isDirectory() || !ID.test(name)) continue;
    if (fs.realpathSync(folder) !== folder) fail();
    const file = path.join(folder, 'dispatch-plugin.json');
    if (!fs.existsSync(file)) continue;
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile() || fs.statSync(file).size > MAX_MANIFEST_BYTES) fail();
    const plugin = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (plugin.id !== name) fail();
    plugins.push(plugin);
  }
  return validateCatalog(plugins);
}
function validateCatalog(plugins) {
  if(!Array.isArray(plugins))fail();
  plugins=plugins.map(validateManifest);
  for (const field of ['id', 'pages', 'httpPrefixes', 'gatewayActions', 'services', 'collectors', 'syncs']) {
    const values = plugins.flatMap(plugin => field === 'id' ? [plugin.id]
      : field === 'pages' ? plugin.pages.map(page => page.id) : plugin[field]);
    if (values.length !== new Set(values).size) fail();
  }
  return Object.freeze(plugins);
}
let cached, provider = null;
function configureCatalog(load) {
  if (typeof load !== 'function') throw new TypeError('plugin_catalog_provider_required');
  provider = load; cached = null;
}
function catalog() { return provider ? validateCatalog(provider()) : cached ||= loadCatalog(); }
function plugin(id) { return catalog().find(item => item.id === id) || null; }
function gatewayPlugin(action, input = {}) {
  return catalog().find(item => item.gatewayActions.includes(action)
    || action.startsWith('sync.') && item.syncs.includes(input.id)
    || action === 'connections.manage' && item.services.includes(input.service)) || null;
}
function publicPlugin(value) {
  return { id: value.id, name: value.name, version: value.version, description: value.description, pages: value.pages,
    ...(value.settings ? { hasSettings: true } : {}) };
}
module.exports = { ROOT, STATES, MAX_MANIFEST_BYTES, identifier, catalog, configureCatalog, loadCatalog, validateManifest, pluginEntry, plugin, gatewayPlugin, publicPlugin };
