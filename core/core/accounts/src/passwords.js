'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { AccessError, password } = require('./validation');

const scrypt = promisify(crypto.scrypt);
const PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEY_BYTES = 64;

async function hashPassword(value, salt = crypto.randomBytes(24)) {
  password(value);
  const derived = await scrypt(value, salt, KEY_BYTES, PARAMETERS);
  return `scrypt-v1$${PARAMETERS.N}$${PARAMETERS.r}$${PARAMETERS.p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

function parse(encoded) {
  if (typeof encoded !== 'string') throw new AccessError('credential_record_invalid', 500);
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt-v1') throw new AccessError('credential_record_invalid', 500);
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (N !== PARAMETERS.N || r !== PARAMETERS.r || p !== PARAMETERS.p || salt.length !== 24 || expected.length !== KEY_BYTES) {
    throw new AccessError('credential_record_invalid', 500);
  }
  return { salt, expected };
}

async function verifyPassword(value, encoded) {
  const { salt, expected } = parse(encoded);
  let derived;
  try { derived = Buffer.from(await scrypt(value, salt, expected.length, PARAMETERS)); }
  catch { return false; }
  return crypto.timingSafeEqual(derived, expected);
}

async function consumeEquivalentPasswordWork(value) {
  const selected = typeof value === 'string' ? value : '';
  await scrypt(selected, Buffer.alloc(24, 0x5a), KEY_BYTES, PARAMETERS);
}

module.exports = { PARAMETERS, hashPassword, verifyPassword, consumeEquivalentPasswordWork };
