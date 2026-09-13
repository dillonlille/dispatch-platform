'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest } = require('dispatch-protocol/plugin-sdk/catalog');
const { generateContracts } = require('./plugin-contracts');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
function starterManifest(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('plugin_id_invalid');
  const name = id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  const record = object({ id: { type: 'integer', minimum: 1 }, text: { type: 'string', minLength: 1, maxLength: 200 } });
  return validateManifest({ schemaVersion: 1, id, name, version: '0.1.0', description: 'DSP-owned entries with shared settings and validated operations.',
    frontend: 'frontend/index.tsx', dashboard: null, runtime: 'backend/index.js', published: null,
    pages: [{ id, label: name, icon: 'puzzle', permission: 'dashboard.view' }],
    actions: [
      { id: 'records.list', permission: 'dashboard.view', summary: 'List entries for the current DSP',
        input: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, []),
        output: object({ items: { type: 'array', items: record, maxItems: 100 }, total: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }) },
      { id: 'records.add', permission: 'organization.settings.manage', summary: 'Add an entry for the current DSP',
        errors: ['entries_paused', 'idempotency_conflict', 'invalid_input'],
        input: object({ text: { type: 'string', minLength: 1, maxLength: 200 }, idempotencyKey: { type: 'string', minLength: 16, maxLength: 128 } }), output: record },
    ],
    httpPrefixes: [], gatewayActions: [], services: [], collectors: [], syncs: [], jobs: [], legacyProfile: null,
    settings: { version: 1, sections: [{ id: 'general', label: 'General' }], fields: [
      { id: 'allow_entries', section: 'general', label: 'Allow new entries', type: 'boolean', default: true, applies: 'next_job' },
    ] },
    package: { runtime: 'backend/index.js', authentication: null, collections: null },
  });
}
function createPlugin({ id, directory = path.resolve('plugins', id) }) {
  const manifest = starterManifest(id);
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: false }); // Never overwrite existing work.
  for (const folder of ['backend', 'frontend']) fs.mkdirSync(path.join(directory, folder));
  fs.writeFileSync(path.join(directory, 'dispatch-plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [template, target] of [['backend.js', 'backend/index.js'], ['frontend.tsx', 'frontend/index.tsx']]) {
    fs.writeFileSync(path.join(directory, target), fs.readFileSync(path.join(__dirname, 'plugin-template', template), 'utf8')
      .replaceAll('__PLUGIN_ID__', id).replaceAll('__PLUGIN_TITLE__', manifest.name));
  }
  fs.writeFileSync(path.join(directory, 'README.md'), `# ${manifest.name}\n\nEdit the manifest to declare settings, operations and permissions. Edit backend/index.js for business logic and frontend/index.tsx for the page.\n\nFrom the platform source root:\n\n- \`bin/dispatch plugin generate ${id}\`: regenerate clients and OpenAPI after changing the manifest.\n- \`bin/dispatch plugin dev ${id}\`: build and start a separate synthetic workspace with two DSP owners.\n- \`bin/dispatch plugin check ${id}\`: verify contracts and the installable package.\n\nThe starter uses existing dashboard.view and organization.settings.manage grants; choose the existing permission appropriate to each operation. This example does not define new platform roles.\n\nThe development runner uses synthetic accounts and DSP-local SQLite files. It is for trusted local development, not a security sandbox. Real DSP installation still goes through the approved package catalog and isolated worker lifecycle.\n`);
  generateContracts(directory);
  return { id, directory };
}
module.exports = { starterManifest, createPlugin };
