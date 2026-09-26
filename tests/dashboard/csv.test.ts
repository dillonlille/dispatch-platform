import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell, csvText } from '../../dashboard/src/lib/csv.js';

test('CSV cells cannot become spreadsheet formulas', () => {
  for (const value of [
    '=1+1',
    '+cmd',
    '-2+3',
    '@SUM(A1:A2)',
    '\t=1',
    '\r@x',
    '\n+1',
    '\u2003-1',
    '  =1',
  ]) {
    assert.equal(csvCell(value), `"'${value}"`);
  }
  assert.equal(csvCell('ordinary'), '"ordinary"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(null), '""');
});

test('CSV headers and rows receive the same quoting and formula protection', () => {
  assert.equal(
    csvText(['Name, displayed', '=unsafe'], [['Alice', 12]]),
    '"Name, displayed","\'=unsafe"\r\n"Alice","12"',
  );
});
