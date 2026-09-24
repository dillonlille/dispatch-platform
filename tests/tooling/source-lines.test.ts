import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Needs no build, so `npm run check:rules` catches a long line before a push does.
test('backend source lines fit in 140 characters', () => {
  const root = 'backend/src';
  const long = new Map<string, number>();
  for (const name of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.rs')) continue;
    // Lines end at \n or \r\n, and a character is a code point, as Rust counts them.
    for (const line of fs.readFileSync(`${root}/${name}`, 'utf8').split('\n'))
      if ([...line.replace(/\r$/, '')].length > 140) long.set(name, (long.get(name) ?? 0) + 1);
  }
  // Raw email markup and embedded provider scripts have a fixed exception budget.
  // These budgets only shrink: wrapping an exception requires lowering its count.
  const exceptions: [string, number][] = [
    ['mail/templates.rs', 4],
    ['browsers/paycom/benchmark.rs', 2],
    ['browsers/paycom/collection.rs', 3],
  ];
  for (const [file, expected] of exceptions) {
    assert.equal(
      long.get(file) ?? 0,
      expected,
      `reduce the exception budget when wrapping ${file}; never increase it`,
    );
    long.delete(file);
  }
  assert.deepEqual([...long.keys()], [], 'lines over 140 characters');
});
