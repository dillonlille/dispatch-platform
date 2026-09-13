'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { weekForSourceDate, periodFromWeek } = require('./periods');

const MAX_CSV_BYTES = 67_108_864;
const MAX_PROVIDER_BYTES = 33_554_432;
const MAX_ROWS = 100_000;
const CATEGORY_COLUMNS = Object.freeze([
  'DA Mishandled Package',
  'DA was Unprofessional',
  'DA did not follow my delivery instructions',
  'Delivered to Wrong Address',
  'Never Received Delivery',
  'Received Wrong Item',
]);
const SCHEMAS = Object.freeze({
  'cdf-negative-v1': Object.freeze([
    'Delivery Group ID', 'Delivery Associate', 'Delivery Associate Name',
    ...CATEGORY_COLUMNS, 'Feedback Details', 'Tracking ID', 'Delivery Date',
  ]),
  'cdf-negative-v2': Object.freeze([
    'Delivery Group ID', 'Delivery Associate', 'Delivery Associate Name', 'Impacts Scorecard',
    ...CATEGORY_COLUMNS, 'Feedback Details', 'Tracking ID', 'Delivery Date',
  ]),
  'cdf-negative-v3': Object.freeze([
    'Delivery Group ID', 'Delivery Associate', 'Delivery Associate Name', 'Impacts Scorecard', 'Tracking ID',
    ...CATEGORY_COLUMNS, 'Feedback Details', 'Dispute status', 'Delivery Date',
  ]),
});
const PROVIDER_RE = /^amzn1\.flex\.provider\.v1\.[A-Za-z0-9-]{8,128}$/;

function fail(code = 'artifact_invalid') {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function decodeUtf8(bytes, code) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(code); }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let justClosedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; justClosedQuote = true; }
      } else field += character;
      continue;
    }
    if (justClosedQuote && ![',', '\r', '\n'].includes(character)) fail('csv_parse_invalid');
    if (character === '"') {
      if (field !== '') fail('csv_parse_invalid');
      quoted = true;
      justClosedQuote = false;
    } else if (character === ',') {
      row.push(field); field = ''; justClosedQuote = false;
    } else if (character === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; justClosedQuote = false;
    } else if (character === '\r') {
      if (text[index + 1] !== '\n') fail('csv_parse_invalid');
    } else {
      field += character;
      justClosedQuote = false;
    }
    if (rows.length > MAX_ROWS + 1) fail('csv_too_many_rows');
  }
  if (quoted) fail('csv_parse_invalid');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length > MAX_ROWS + 1) fail('csv_too_many_rows');
  return rows;
}

function validateCsv(bytes, week) {
  periodFromWeek(week);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_CSV_BYTES) fail('csv_size_invalid');
  const text = decodeUtf8(bytes, 'csv_encoding_invalid');
  const lowered = text.trimStart().slice(0, 32).toLowerCase();
  if (lowered.startsWith('<!doctype html') || lowered.startsWith('<html')) fail('csv_is_html');
  const rows = parseCsv(text);
  if (!rows.length) fail('csv_empty');
  if (rows[0][0]?.startsWith('\uFEFF')) rows[0][0] = rows[0][0].slice(1);
  const header = rows[0];
  const schema = Object.entries(SCHEMAS).find(([, columns]) =>
    columns.length === header.length && columns.every((column, index) => column === header[index]))?.[0];
  if (!schema) fail('csv_schema_invalid');
  const columns = SCHEMAS[schema];
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index];
    if (values.length !== columns.length) fail('csv_row_width_invalid');
    const rowValue = Object.fromEntries(columns.map((column, position) => [column, values[position]]));
    if (!rowValue['Delivery Group ID'].trim() || !rowValue['Delivery Associate'].trim() || !rowValue['Tracking ID'].trim()) {
      fail('csv_identity_missing');
    }
    if (CATEGORY_COLUMNS.some(column => !['0', '1'].includes(rowValue[column].trim()))) fail('csv_category_invalid');
    const date = rowValue['Delivery Date'].trim();
    if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(date)) fail('csv_delivery_date_invalid');
    let deliveryWeek;
    try { deliveryWeek = weekForSourceDate(date.slice(0, 10)); }
    catch { fail('csv_delivery_date_invalid'); }
    if (deliveryWeek !== week) fail('csv_wrong_week');
  }
  return {
    schema,
    rowCount: rows.length - 1,
    columnCount: header.length,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function validateProviderJson(bytes, week) {
  periodFromWeek(week);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PROVIDER_BYTES) fail('provider_size_invalid');
  let payload;
  try { payload = JSON.parse(decodeUtf8(bytes, 'provider_encoding_invalid')); }
  catch (error) { if (error?.code) throw error; fail('provider_json_invalid'); }
  if (!exactKeys(payload, ['contract_version', 'week', 'rows']) || payload.contract_version !== 1
      || payload.week !== week || !Array.isArray(payload.rows) || payload.rows.length > MAX_ROWS) fail('provider_contract_invalid');
  const identities = new Set();
  for (const row of payload.rows) {
    if (!exactKeys(row, ['da_name', 'transporter_id', 'provider_id'])
        || Object.values(row).some(value => typeof value !== 'string')) fail('provider_row_invalid');
    const daName = row.da_name.trim();
    const transporterId = row.transporter_id.trim();
    const providerId = row.provider_id.trim();
    if (!daName || !transporterId || !PROVIDER_RE.test(providerId)) fail('provider_row_invalid');
    const identity = `${transporterId.toLowerCase()}\0${providerId.toLowerCase()}`;
    if (identities.has(identity)) fail('provider_row_duplicate');
    identities.add(identity);
  }
  return { rowCount: payload.rows.length, bytes: bytes.length, sha256: sha256(bytes) };
}

function emptyProviderBytes(week) {
  periodFromWeek(week);
  return Buffer.from(`${JSON.stringify({ contract_version: 1, week, rows: [] })}\n`);
}

module.exports = {
  MAX_CSV_BYTES, MAX_PROVIDER_BYTES, MAX_ROWS, CATEGORY_COLUMNS, SCHEMAS, PROVIDER_RE,
  fail, plain, exactKeys, sha256, canonicalStringify, parseCsv, validateCsv,
  validateProviderJson, emptyProviderBytes,
};
