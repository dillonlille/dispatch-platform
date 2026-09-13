'use strict';

const { exactObject, invalid, identifier, IDEMPOTENCY_RE } = require('./input');
const { jsonValue } = require('./result');

function syncEditPatch(value) {
  exactObject(value, ['intervalSeconds', 'jitterSeconds', 'settings', 'replaceSettings']);
  if (Object.keys(value).length === 0) invalid();
  if (value.intervalSeconds !== undefined
      && (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 10 || value.intervalSeconds > 31_536_000)) invalid();
  if (value.jitterSeconds !== undefined && (!Number.isInteger(value.jitterSeconds) || value.jitterSeconds < 0)) invalid();
  if (value.settings !== undefined
      && (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)
        || Object.getPrototypeOf(value.settings) !== Object.prototype)) invalid();
  if (value.replaceSettings !== undefined && typeof value.replaceSettings !== 'boolean') invalid();
  if (value.replaceSettings === true && value.settings === undefined) invalid();
  return jsonValue(value);
}

function syncEditOptions(value = {}) {
  exactObject(value, ['expectedRevision', 'applyNow']);
  if (value.expectedRevision !== undefined
      && (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 1)) invalid();
  if (value.applyNow !== undefined && typeof value.applyNow !== 'boolean') invalid();
  return { expectedRevision: value.expectedRevision ?? null, applyNow: value.applyNow ?? false };
}

function syncStopOptions(value = {}) {
  exactObject(value, ['drain', 'waitMs']);
  if (value.drain !== undefined && typeof value.drain !== 'boolean') invalid();
  if (value.waitMs !== undefined
      && (!Number.isInteger(value.waitMs) || value.waitMs < 0 || value.waitMs > 120_000)) invalid();
  return { drain: value.drain ?? false, waitMs: value.waitMs ?? 30_000 };
}

function syncRunOptions(value = {}) {
  exactObject(value, ['idempotencyKey']);
  if (value.idempotencyKey !== undefined) identifier(value.idempotencyKey, IDEMPOTENCY_RE);
  return { idempotencyKey: value.idempotencyKey ?? null };
}

module.exports = { syncEditPatch, syncEditOptions, syncStopOptions, syncRunOptions };
