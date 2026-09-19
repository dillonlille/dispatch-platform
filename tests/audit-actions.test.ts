import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The audit log writes each event as a sentence. An action the backend records
// without wording would fall back to its raw id, so every one must be covered.
test('every audit action the backend records has wording in the audit log', () => {
  const sources = fs
    .readdirSync('backend/src', { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.rs'))
    .map((file) => fs.readFileSync(path.join('backend/src', file), 'utf8'))
    .join('\n');
  const recorded = new Set<string>();
  for (const call of sources.matchAll(/\.audit(?:_with)?\(/g))
    for (const [, action] of sources
      .slice(call.index, call.index + 420)
      .matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/g))
      recorded.add(action!);
  // Password changes pass their action through a helper.
  for (const [, action] of sources.matchAll(/replace_password\([^;]*?"(account\.[a-z_]+)"/g))
    recorded.add(action!);
  const permissions = /^(timecard|collections|connections|members|roles|settings|audit)\./;
  const actions = [...recorded].filter((action) => !permissions.test(action)).sort();
  assert(actions.length > 30, `found only ${actions.length} actions`);
  const log = fs.readFileSync('dashboard/src/audit.tsx', 'utf8');
  const worded = new Set([...log.matchAll(/^ {2}'([a-z_.]+)':/gm)].map(([, action]) => action));
  assert.deepEqual(
    actions.filter((action) => !worded.has(action)),
    [],
  );
});
