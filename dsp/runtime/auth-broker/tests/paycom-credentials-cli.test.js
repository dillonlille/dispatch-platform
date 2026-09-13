'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parse, usage } = require('../src/paycom-credentials-cli');

test('Paycom credential CLI defaults to the registered profile and accepts only enrollment operations', () => {
  assert.deepEqual(parse(['enroll']), { operation: 'enroll', profile: 'paycom-main' });
  assert.deepEqual(parse(['replace', 'paycom-backup']), { operation: 'replace', profile: 'paycom-backup' });
  assert.throws(() => parse([]), /invalid_request/);
  assert.throws(() => parse(['enroll', 'paycom-main', 'secret']), /invalid_request/);
  assert.throws(() => parse(['show', 'paycom-main']), /invalid_request/);
  assert.equal(usage().includes('Credential values are accepted only from /dev/tty'), true);
});
