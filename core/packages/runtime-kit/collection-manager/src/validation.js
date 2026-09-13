'use strict';

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const METHOD_RE = /^[a-z][a-z0-9_.-]{0,95}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SECRET_KEY_RE = /(password|passwd|secret|credential|token|cookie|authorization|bearer|private[_-]?key|oauth|session|api[_-]?key|(?:^|[_-])pin\d*(?:$|[_-]))/i;

class ValidationError extends Error {
  constructor(code = 'invalid_input') {
    super(code);
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, allowed, required = allowed) {
  if (!plainObject(value)) throw new ValidationError();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new ValidationError();
}

function identifier(value, pattern = ID_RE) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ValidationError();
  return value;
}

function boundedJson(value, { maxBytes = 32_768, denySecrets = true } = {}) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new ValidationError(); }
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) throw new ValidationError();
  const visit = (current, depth) => {
    if (depth > 10) throw new ValidationError();
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new ValidationError();
      return;
    }
    if (typeof current === 'string') {
      if (current.length > 4096 || /[\0]/.test(current)) throw new ValidationError();
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > 128) throw new ValidationError();
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (!plainObject(current) || Object.keys(current).length > 128) throw new ValidationError();
    for (const [key, item] of Object.entries(current)) {
      if (key.length < 1 || key.length > 64 || /[\0\r\n]/.test(key) || (denySecrets && SECRET_KEY_RE.test(key))) throw new ValidationError('secret_field_forbidden');
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return value;
}

function validateSchema(schema) {
  exactKeys(schema, ['type', 'properties', 'required', 'additionalProperties'], ['type', 'properties', 'required', 'additionalProperties']);
  if (schema.type !== 'object' || schema.additionalProperties !== false || !plainObject(schema.properties) || !Array.isArray(schema.required)) throw new ValidationError();
  if (Object.keys(schema.properties).length > 64 || schema.required.length > 64 || new Set(schema.required).size !== schema.required.length) throw new ValidationError();
  for (const [name, rule] of Object.entries(schema.properties)) {
    identifier(name, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
    exactKeys(rule, ['type', 'maxLength', 'minimum', 'maximum', 'enum', 'pattern'], ['type']);
    if (!['string', 'integer', 'number', 'boolean'].includes(rule.type)) throw new ValidationError();
    if (rule.maxLength !== undefined && (!Number.isInteger(rule.maxLength) || rule.maxLength < 1 || rule.maxLength > 4096)) throw new ValidationError();
    if (rule.minimum !== undefined && typeof rule.minimum !== 'number') throw new ValidationError();
    if (rule.maximum !== undefined && typeof rule.maximum !== 'number') throw new ValidationError();
    if (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum) throw new ValidationError();
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || rule.enum.length < 1 || rule.enum.length > 64)) throw new ValidationError();
    if (rule.pattern !== undefined) {
      if (typeof rule.pattern !== 'string' || rule.pattern.length > 128) throw new ValidationError();
      try { new RegExp(rule.pattern, 'u'); } catch { throw new ValidationError(); }
    }
  }
  if (schema.required.some(name => !Object.hasOwn(schema.properties, name))) throw new ValidationError();
  return schema;
}

function validateAgainstSchema(value, schema) {
  validateSchema(schema);
  if (!plainObject(value)) throw new ValidationError();
  const keys = Object.keys(value);
  if (keys.some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(value, key))) throw new ValidationError();
  for (const [key, item] of Object.entries(value)) {
    const rule = schema.properties[key];
    if (rule.type === 'string' && typeof item !== 'string') throw new ValidationError();
    if (rule.type === 'integer' && !Number.isInteger(item)) throw new ValidationError();
    if (rule.type === 'number' && (typeof item !== 'number' || !Number.isFinite(item))) throw new ValidationError();
    if (rule.type === 'boolean' && typeof item !== 'boolean') throw new ValidationError();
    if (rule.maxLength !== undefined && item.length > rule.maxLength) throw new ValidationError();
    if (rule.minimum !== undefined && item < rule.minimum) throw new ValidationError();
    if (rule.maximum !== undefined && item > rule.maximum) throw new ValidationError();
    if (rule.enum !== undefined && !rule.enum.some(candidate => Object.is(candidate, item))) throw new ValidationError();
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, 'u').test(item)) throw new ValidationError();
  }
  boundedJson(value);
  return value;
}

function validateSchedule(schedule) {
  if (!plainObject(schedule) || typeof schedule.type !== 'string') throw new ValidationError();
  if (schedule.type === 'manual') exactKeys(schedule, ['type']);
  else if (schedule.type === 'interval') {
    exactKeys(schedule, ['type', 'seconds']);
    if (!Number.isInteger(schedule.seconds) || schedule.seconds < 10 || schedule.seconds > 31_536_000) throw new ValidationError();
  } else if (schedule.type === 'cron') {
    exactKeys(schedule, ['type', 'expression', 'timezone']);
    if (typeof schedule.expression !== 'string' || schedule.expression.length > 100) throw new ValidationError();
    if (typeof schedule.timezone !== 'string' || schedule.timezone.length > 64) throw new ValidationError();
    try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone }).format(new Date()); } catch { throw new ValidationError(); }
    require('dispatch-runtime-kit/collection-manager/src/cron').parseCron(schedule.expression);
  } else throw new ValidationError();
  return schedule;
}

function validateSpec(spec) {
  exactKeys(spec, ['schemaVersion', 'collectors', 'sources', 'plans', 'syncs'],
    ['schemaVersion', 'collectors', 'sources', 'plans']);
  if (spec.schemaVersion !== 1 || !Array.isArray(spec.collectors) || !Array.isArray(spec.sources)
      || !Array.isArray(spec.plans) || spec.syncs !== undefined && !Array.isArray(spec.syncs)) throw new ValidationError();
  if (spec.collectors.length > 128 || spec.sources.length > 512 || spec.plans.length > 2048
      || (spec.syncs?.length || 0) > 512) throw new ValidationError();
  boundedJson(spec, { maxBytes: 262_144 });
  return spec;
}

module.exports = {
  ID_RE, METHOD_RE, VERSION_RE, ValidationError, plainObject, exactKeys, identifier,
  boundedJson, validateSchema, validateAgainstSchema, validateSchedule, validateSpec,
};
