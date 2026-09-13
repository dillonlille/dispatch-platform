'use strict';
const { boundedJson, DispatchError, plain, MAX_RESULT_BYTES } = require('./protocol');

const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];
const SCHEMA_KEYS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'description'];
function invalid(code) { throw new DispatchError(code); }
function validateSchema(schema) {
  schema = boundedJson(schema);
  function visit(value, depth) {
    if (depth > 12 || !plain(value) || Object.keys(value).some(key => !SCHEMA_KEYS.includes(key))
        || !TYPES.includes(value.type)) invalid('operation_schema_invalid');
    if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1000)) invalid('operation_schema_invalid');
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 100 || new Set(value.enum).size !== value.enum.length
        || value.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item)))) invalid('operation_schema_invalid');
    for (const [lower, upper, types] of [['minLength', 'maxLength', ['string']], ['minimum', 'maximum', ['integer', 'number']], ['minItems', 'maxItems', ['array']]]) {
      for (const key of [lower, upper]) if (value[key] !== undefined && (!types.includes(value.type)
          || !Number.isFinite(value[key]) || (key !== 'minimum' && key !== 'maximum') && (!Number.isInteger(value[key]) || value[key] < 0))) invalid('operation_schema_invalid');
      if (value[lower] !== undefined && value[upper] !== undefined && value[lower] > value[upper]) invalid('operation_schema_invalid');
    }
    if (value.type === 'object') {
      if (!plain(value.properties) || value.additionalProperties !== false || !Array.isArray(value.required)
          || Object.keys(value.properties).length > 128 || new Set(value.required).size !== value.required.length
          || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties, key))) invalid('operation_schema_invalid');
      for (const [key, child] of Object.entries(value.properties)) {
        if (BAD_KEYS.includes(key) || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) invalid('operation_schema_invalid');
        visit(child, depth + 1);
      }
    } else if (['properties', 'required', 'additionalProperties'].some(key => Object.hasOwn(value, key))) invalid('operation_schema_invalid');
    if (value.type === 'array') visit(value.items, depth + 1);
    else if (Object.hasOwn(value, 'items')) invalid('operation_schema_invalid');
    if (value.enum) for (const item of value.enum) validateValue({ ...value, enum: undefined }, item, 'operation_schema_invalid');
  }
  visit(schema, 0);
  return schema;
}
function validateValue(schema, value, code = 'invalid_input') {
  try { value = boundedJson(value, MAX_RESULT_BYTES); } catch { invalid(code); }
  function visit(shape, item) {
    const valid = shape.type === 'null' ? item === null : shape.type === 'object' ? plain(item)
      : shape.type === 'array' ? Array.isArray(item) : shape.type === 'integer' ? Number.isSafeInteger(item)
        : shape.type === 'number' ? typeof item === 'number' && Number.isFinite(item) : typeof item === shape.type;
    if (!valid || shape.enum && !shape.enum.includes(item)) invalid(code);
    if (shape.type === 'object') {
      if (shape.required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !Object.hasOwn(shape.properties, key))) invalid(code);
      for (const [key, child] of Object.entries(item)) visit(shape.properties[key], child);
    } else if (shape.type === 'array') {
      if (shape.minItems !== undefined && item.length < shape.minItems || shape.maxItems !== undefined && item.length > shape.maxItems) invalid(code);
      item.forEach(child => visit(shape.items, child));
    } else if (shape.type === 'string') {
      const length = [...item].length;
      if (shape.minLength !== undefined && length < shape.minLength || shape.maxLength !== undefined && length > shape.maxLength) invalid(code);
    } else if (shape.type === 'integer' || shape.type === 'number') {
      if (shape.minimum !== undefined && item < shape.minimum || shape.maximum !== undefined && item > shape.maximum) invalid(code);
    }
  }
  visit(schema, value); return value;
}
function validateOperation(value) {
  value = boundedJson(value);
  if (!plain(value) || Object.keys(value).some(key => !['id', 'permission', 'summary', 'input', 'output', 'errors'].includes(key))
      || typeof value.id !== 'string' || !/^[a-z][a-z0-9_.]{0,63}$/.test(value.id)
      || typeof value.permission !== 'string' || !/^[a-z][a-z.]{0,63}$/.test(value.permission)
      || value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > 200)) invalid('operation_definition_invalid');
  if (value.input !== undefined) { value.input = validateSchema(value.input); if (value.input.type !== 'object') invalid('operation_schema_invalid'); }
  if (value.output !== undefined) value.output = validateSchema(value.output);
  if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 32 || new Set(value.errors).size !== value.errors.length
      || value.errors.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)))) invalid('operation_definition_invalid');
  return value;
}
function operationInput(operation, input) { return operation.input ? validateValue(operation.input, input) : boundedJson(input); }
function operationOutput(operation, output) { return operation.output ? validateValue(operation.output, output, 'invalid_response') : boundedJson(output, MAX_RESULT_BYTES); }
function createOperationClient({ actions, invoke }) {
  if (typeof invoke !== 'function' || !Array.isArray(actions)) throw new TypeError('operation_client_required');
  const client = Object.create(null);
  for (const action of actions) {
    const definition = validateOperation(action);
    if (Object.hasOwn(client, definition.id)) invalid('operation_definition_invalid');
    client[definition.id] = async (input = {}, options) => {
      const result = await invoke(definition.id, operationInput(definition, input), options);
      if (result?.ok !== true) throw new DispatchError(/^[a-z][a-z0-9_]{0,79}$/.test(result?.error?.code || '') ? result.error.code : 'invalid_response',
        { recoverable: result?.error?.recoverable === true });
      return operationOutput(definition, result.data);
    };
  }
  return Object.freeze(client);
}
module.exports = { validateSchema, validateValue, validateOperation, operationInput, operationOutput, createOperationClient };
