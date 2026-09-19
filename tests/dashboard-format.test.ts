import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bytes,
  duration,
  elapsed,
  personName,
  time,
  timeOfDay,
  title,
} from '../dashboard/src/lib/format.js';
import { backoff } from '../dashboard/src/lib/backoff.js';
import { messageOf } from '../dashboard/src/lib/errors.js';

test('timestamps read in the timezone they are given', () => {
  assert.equal(time('2026-09-18T15:03:25Z', 'America/Chicago'), 'Sep 18, 10:03 AM');
  assert.equal(time('2026-09-18T15:03:25Z', 'UTC'), 'Sep 18, 3:03 PM');
  assert.equal(timeOfDay('2026-09-18T15:03:25Z', 'America/Los_Angeles'), '8:03 AM');
  assert.equal(timeOfDay('2000-01-01T00:00:00Z', 'UTC'), '12:00 AM');
});

test('a missing timestamp reads Never unless the caller words it', () => {
  assert.equal(time(null, 'UTC'), 'Never');
  assert.equal(time(undefined, 'UTC'), 'Never');
  assert.equal(time(null, 'UTC', 'Not scheduled'), 'Not scheduled');
});

test('identifiers become titles', () => {
  assert.equal(title('waiting_verification'), 'Waiting Verification');
  assert.equal(title('dsp.view_opened'), 'Dsp View Opened');
});

test('measured durations keep their precision and recorded seconds stay whole', () => {
  assert.equal(duration(null), '—');
  assert.equal(duration(999.6), '1000 ms');
  assert.equal(duration(45_000), '45.0 s');
  assert.equal(duration(200_000), '3m 20s');
  assert.equal(elapsed(45), '45s');
  assert.equal(elapsed(200), '3m 20s');
});

test('byte counts use binary units', () => {
  assert.equal(bytes(700 * 1024 ** 2, 'MiB'), '700 MiB');
  assert.equal(bytes(700.5 * 1024 ** 2, 'MiB'), '701 MiB');
  assert.equal(bytes(734_003_200, 'MiB', 1), '700.0 MiB');
  assert.equal(bytes(1.26 * 1024 ** 3, 'GiB', 1), '1.3 GiB');
});

test('names follow the chosen order and keep a provider’s own Last, First', () => {
  assert.equal(personName('Morgan, Alex', 'first_last'), 'Alex Morgan');
  assert.equal(personName('Morgan, Alex', 'last_first'), 'Morgan, Alex');
  assert.equal(personName('Alex  J Morgan', 'last_first'), 'Morgan, Alex J');
  assert.equal(personName('Alex  J Morgan', 'first_last'), 'Alex J Morgan');
  assert.equal(personName('Cher', 'last_first'), 'Cher');
  assert.equal(personName('Cher,', 'last_first'), 'Cher');
});

test('retries back off from one second to fifteen', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoff), [1000, 2000, 4000, 8000, 15000, 15000]);
});

test('an error message falls back only when there is none', () => {
  assert.equal(
    messageOf(new Error('Keep at least one DSP owner.')),
    'Keep at least one DSP owner.',
  );
  assert.equal(messageOf('nope'), 'The request could not be completed.');
  assert.equal(messageOf(new Error('')), 'The request could not be completed.');
});
