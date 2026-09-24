import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { permissions } from '../../shared/contracts/accounts.js';
import {
  impliedPermissions,
  permissionGroups,
  permissionLabels,
} from '../../dashboard/src/app/permissions.js';

test('every permission has a label and one section in the role sheet', () => {
  const grouped = permissionGroups.flatMap(([, items]) => items);
  assert.deepEqual([...grouped].sort(), [...permissions].sort());
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(Object.keys(permissionLabels).sort(), [...permissions].sort());
});

test('the dashboard mirrors the backend permission catalog and its implications', () => {
  const roles = fs.readFileSync('backend/src/roles.rs', 'utf8');
  const catalog = /PERMISSIONS: &\[&str\] = &\[([^\]]*)\]/.exec(roles)![1]!;
  assert.deepEqual(
    [...catalog.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    [...permissions],
  );
  const implied = /IMPLIED: &\[\(&str, &str\)\] = &\[([^\]]*)\]/.exec(roles)![1]!;
  assert.deepEqual(
    Object.fromEntries([...implied.matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]])),
    impliedPermissions,
  );
});
