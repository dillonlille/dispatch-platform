'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest } = require('dispatch-protocol/plugin-sdk/catalog');

function typeFor(schema) {
  if (!schema) return 'unknown';
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (schema.type === 'object') return '{ ' + Object.entries(schema.properties)
    .map(([key, child]) => `${JSON.stringify(key)}${schema.required.includes(key) ? '' : '?'}: ${typeFor(child)}`).join('; ') + ' }';
  if (schema.type === 'array') return `Array<${typeFor(schema.items)}>`;
  return schema.type === 'integer' ? 'number' : schema.type;
}
function contractFiles(manifest) {
  const definition = validateManifest(manifest), paths = {};
  for (const operation of definition.actions) {
    paths[`/api/plugins/${definition.id}/${operation.id}`] = { post: {
      operationId: `${definition.id}.${operation.id}`, summary: operation.summary || operation.id,
      'x-dispatch-permission': operation.permission,
      ...(operation.errors ? { 'x-dispatch-errors': operation.errors } : {}),
      description: 'Requires an enabled installation and current DSP authority. DSP scope comes from the authenticated session or signed support view.',
      security: [{ session: [], csrf: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: operation.input || { type: 'object' } } } },
      responses: {
        200: { description: 'Operation completed', content: { 'application/json': { schema: {
          type: 'object', required: ['ok', 'data', 'status', 'contractVersion'], properties: {
            ok: { const: true }, contractVersion: { const: 1 }, status: { type: 'string' }, data: operation.output || {},
          }, additionalProperties: false,
        } } } },
        400: { description: 'Invalid input' }, 401: { description: 'Authentication required' },
        403: { description: 'Permission or request verification failed' },
        409: { description: 'Operation rejected or installation changed' }, 503: { description: 'Service unavailable' },
      },
    } };
  }
  const openapi = { openapi: '3.1.0', info: { title: `${definition.name} operations`, version: definition.version },
    paths, components: { securitySchemes: {
      session: { type: 'apiKey', in: 'cookie', name: 'dispatch_session' },
      csrf: { type: 'apiKey', in: 'header', name: 'X-Dispatch-CSRF' },
    } } };
  return {
    'openapi.json': JSON.stringify(openapi, null, 2) + '\n',
    'client.js': "'use strict';\n// Generated from dispatch-plugin.json. Do not edit.\nconst { createOperationClient } = require('dispatch-sdk/operations');\n"
      + `const actions = ${JSON.stringify(definition.actions, null, 2)};\nfunction createClient(invoke) { return createOperationClient({ actions, invoke }); }\nmodule.exports = { createClient };\n`,
    'client.d.ts': '// Generated from dispatch-plugin.json. Do not edit.\nimport type { Json, RequestOptions } from "dispatch-sdk";\n'
      + 'export interface Client {\n' + definition.actions.map(action =>
        `  ${JSON.stringify(action.id)}(input${action.input?.required?.length ? '' : '?'}: ${typeFor(action.input) === 'unknown' ? 'Record<string, Json>' : typeFor(action.input)}, options?: RequestOptions): Promise<${typeFor(action.output)}>;`).join('\n')
      + '\n}\nexport function createClient(invoke: (action: string, input: Json, options?: RequestOptions) => Promise<unknown>): Client;\n',
  };
}
function generateContracts(pluginRoot, { check = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'dispatch-plugin.json'), 'utf8'));
  const files = contractFiles(manifest), directory = path.join(pluginRoot, 'generated');
  if (!check) fs.mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) throw new Error('plugin_contracts_stale');
    } else fs.writeFileSync(file, content);
  }
  return { id: manifest.id, operations: manifest.actions.length, files: Object.keys(files) };
}
module.exports = { contractFiles, generateContracts };
if (require.main === module) {
  const [directory, flag] = process.argv.slice(2);
  if (!directory || flag && flag !== '--check') throw new Error('plugin_contract_arguments_invalid');
  console.log(JSON.stringify(generateContracts(path.resolve(directory), { check: flag === '--check' })));
}
