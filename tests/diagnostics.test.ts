import test from 'node:test';
import assert from 'node:assert/strict';
import type { MailMessage, PlatformHealth } from '../shared/contracts/index.js';
import { issues } from '../dashboard/src/features/platform/diagnostics/attention.js';
import { stage } from '../dashboard/src/features/platform/diagnostics/mail.js';

const health = (canStart: boolean, failed: number) =>
  ({
    browsers: {
      memory: { canStart, availableBytes: 900 * 1024 ** 2, requiredBytes: 1536 * 1024 ** 2 },
    },
    mail: { failed },
  }) as PlatformHealth;
const diagnostics = (storageAvailableBytes: number) => ({
  enabled: true,
  storageAvailableBytes,
  runtime: { name: '', status: 'Running', memoryBytes: 0, browsers: 0 },
  dsps: [],
});

test('a healthy platform needs no attention; memory, storage and failed mail each raise one issue', () => {
  assert.deepEqual(issues(health(true, 0), diagnostics(5 * 1024 ** 3), []), []);
  const found = issues(health(false, 2), diagnostics(200 * 1024 ** 2), []);
  assert.deepEqual(
    found.map((issue) => issue.id),
    ['browser-memory', 'storage', 'email'],
  );
  assert.match(found[0]!.details[0]!, /900 MiB free, 1536 MiB needed/);
  assert.deepEqual(found[2]!.open, { tab: 'email' });
  assert.equal(found[2]!.details[0], '2 failed deliveries');
});

test('an email is undelivered, waiting on the person, or done', () => {
  const message = (fields: Partial<MailMessage>) =>
    ({ status: 'sent', kind: 'invitation', owner: false, ...fields }) as MailMessage;
  assert.equal(stage(message({ status: 'failed' })), 'undelivered');
  assert.equal(stage(message({ status: 'pending' })), 'undelivered');
  assert.equal(stage(message({ kind: 'reset' })), 'done');
  assert.equal(stage(message({ acceptedAt: null })), 'waiting');
  assert.equal(stage(message({ acceptedAt: '2026-09-20T00:00:00Z' })), 'done');
  const owner = { owner: true, acceptedAt: '2026-09-20T00:00:00Z' };
  assert.equal(stage(message({ ...owner, setupComplete: false })), 'waiting');
  assert.equal(stage(message({ ...owner, setupComplete: true })), 'done');
});
