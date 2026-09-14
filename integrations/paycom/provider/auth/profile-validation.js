'use strict';
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
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


module.exports = { validateProfile };
