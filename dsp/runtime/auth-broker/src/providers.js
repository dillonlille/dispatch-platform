'use strict';

const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;

const PROVIDERS = Object.freeze({
  paycom: Object.freeze({
    fields: Object.freeze([
      ['clientCode', 128],
      ['username', 256],
      ['password', 512],
      ['pin1', 64],
      ['pin2', 64],
      ['pin3', 64],
      ['pin4', 64],
      ['pin5', 64],
    ]),
  }),
  'amazon-logistics': Object.freeze({
    fields: Object.freeze([
      ['username', 320],
      ['password', 4096],
    ]),
  }),
  basic: Object.freeze({
    fields: Object.freeze([
      ['username', 256],
      ['password', 512],
    ]),
  }),
});

class ValidationError extends Error {
  constructor(code = 'invalid_input') {
    super(code);
    this.code = code;
  }
}

function validateProfile(value) {
  if (typeof value !== 'string' || !PROFILE_RE.test(value)) throw new ValidationError();
  return value;
}

function validateProvider(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PROVIDERS, value)) throw new ValidationError();
  return value;
}

function validateCredentials(provider, credentials) {
  validateProvider(provider);
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || Object.getPrototypeOf(credentials) !== Object.prototype) {
    throw new ValidationError();
  }
  const fields = PROVIDERS[provider].fields;
  const expected = fields.map(([name]) => name).sort();
  const actual = Object.keys(credentials).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new ValidationError();
  const clean = {};
  for (const [name, maximum] of fields) {
    const value = credentials[name];
    if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\r\n\0]/.test(value)) throw new ValidationError();
    clean[name] = value;
  }
  if (provider === 'paycom') {
    const pins = ['pin1', 'pin2', 'pin3', 'pin4', 'pin5'].map(name => clean[name]);
    if (new Set(pins).size !== pins.length) throw new ValidationError();
  }
  return clean;
}

function publicProviders() {
  return Object.entries(PROVIDERS).map(([provider, value]) => ({
    provider,
    fields: value.fields.map(([name]) => name),
  }));
}

module.exports = { PROVIDERS, PROFILE_RE, ValidationError, validateProfile, validateProvider, validateCredentials, publicProviders };
