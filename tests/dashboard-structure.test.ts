import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = 'dashboard/src';

// ui/ holds building blocks that would make sense unchanged in another app.
test('ui components know nothing about the product', () => {
  const files = fs.readdirSync(path.join(source, 'ui')).filter((file) => /\.tsx?$/.test(file));
  assert(files.length > 10, `found only ${files.length} ui files`);
  for (const file of files) {
    const text = fs.readFileSync(path.join(source, 'ui', file), 'utf8');
    for (const [, target] of text.matchAll(/from '([^']+)'/g))
      assert(
        !target!.startsWith('.') || target!.startsWith('./') || target!.startsWith('../lib/'),
        `ui/${file} imports ${target}; ui may import packages, ui and lib only`,
      );
  }
});

test('every route is declared once and every parent is a route', () => {
  const text = fs.readFileSync(path.join(source, 'app/routes.tsx'), 'utf8');
  const table = text.slice(text.indexOf('export const routes = ['), text.indexOf('] as const'));
  const entries = table
    .split(/\n {2}\{\n/)
    .slice(1)
    .map((entry) => ({
      id: /^ {4}id: '([^']+)'/m.exec(entry)?.[1],
      scope: /^ {4}scope: '(dsp|platform)'/m.exec(entry)?.[1],
      parent: /^ {4}parent: '([^']+)'/m.exec(entry)?.[1],
    }));
  assert(entries.length >= 10, `found only ${entries.length} routes`);
  for (const entry of entries) {
    assert(entry.id && entry.scope, `unreadable route entry: ${JSON.stringify(entry)}`);
    assert.equal(
      entries.filter((other) => other.scope === entry.scope && other.id === entry.id).length,
      1,
      `${entry.scope} route ${entry.id} is declared more than once`,
    );
    if (entry.parent)
      assert(
        entries.some((other) => other.scope === entry.scope && other.id === entry.parent),
        `${entry.id} names ${entry.parent} as its parent, which is not a ${entry.scope} route`,
      );
  }
});
