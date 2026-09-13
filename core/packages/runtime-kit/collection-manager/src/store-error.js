'use strict';

class StoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

module.exports = { StoreError };
