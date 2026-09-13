'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSchema, validateOperation, operationInput, createOperationClient } = require('../src/operations');
const { definePlugin } = require('../node/plugin');
const input = { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['count'], additionalProperties: false };
const operation = { id: 'records.count', permission: 'dashboard.view', input, output: { type: 'integer', minimum: 1, maximum: 10 } };

test('operation contracts reject undeclared scope, invalid bounds, unsafe schema keys and inherited handlers', () => {
  validateOperation(operation);
  for (const value of [{}, { count: 0 }, { count: 2.5 }, { count: '2' }, { count: 2, dspId: 'sibling' }]) assert.throws(() => operationInput(operation, value), /invalid_input/);
  assert.throws(() => validateSchema({ ...input, required: ['missing'] }), /operation_schema_invalid/);
  assert.throws(() => validateSchema({ ...input, additionalProperties: true }), /operation_schema_invalid/);
  assert.throws(() => validateSchema({ type: 'integer', enum: ['wrong type'] }), /operation_schema_invalid/);
  assert.throws(() => validateSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":[],"additionalProperties":false}')));
  assert.throws(() => definePlugin({ actions: [{ ...operation, id: 'constructor' }], handlers: { other: () => 1 } }), /plugin_handlers_invalid/);
});

test('declared business errors cross the worker boundary as safe results and Unicode bounds match JSON Schema', async () => {
  const { DispatchError } = require('../src/protocol');
  const { validateValue } = require('../src/operations');
  const schema = validateSchema({ type: 'string', maxLength: 1 });
  assert.equal(validateValue(schema, '🚚'), '🚚');
  const plugin = definePlugin({ actions: [{ ...operation, errors: ['entries_paused'] }],
    handlers: { 'records.count': () => { throw new DispatchError('entries_paused'); } } });
  const result = await plugin.createPlugin({ dispatch: {} }).invoke(operation.id, { count: 2 });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'entries_paused');
  assert.equal(require('../../shared/contracts/src/result').isResult(result), true);
});

test('SDK client and worker use the same definition and reject invalid results without replaying work', async () => {
  let calls = 0, output = 3;
  const plugin = definePlugin({ actions: [operation], handlers: { 'records.count': ({ input }) => { calls++; return output; } } });
  const worker = plugin.createPlugin({ dispatch: {} });
  const client = createOperationClient({ actions: [operation], invoke: (id, input, options) => worker.invoke(id, input, options) });
  assert.equal(await client['records.count']({ count: 3 }), 3);
  await assert.rejects(client['records.count']({ count: 11 }), /invalid_input/);
  assert.equal(calls, 1);
  output = 11;
  await assert.rejects(client['records.count']({ count: 4 }), /invalid_response/);
  assert.equal(calls, 2);
  const failing = createOperationClient({ actions: [operation], invoke: async () => { calls++; return { ok: false, error: { code: 'entries_paused', recoverable: false } }; } });
  await assert.rejects(failing['records.count']({ count: 2 }), /entries_paused/);
  assert.equal(calls, 3);
});
