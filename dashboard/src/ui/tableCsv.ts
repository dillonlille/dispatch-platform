import { downloadCsv } from '../lib/csv.js';
import { columnName } from './ColumnMenu.js';
import type { DataTable } from './useDataTable.js';

/** Exports the columns on screen, for every row the table holds, in the order shown. */
export function downloadTable<T>(table: DataTable<T>, filename: string) {
  const fields = table.visibleColumns.flatMap(
    (column) =>
      column.exports ?? (column.value ? [[columnName(column), column.value] as const] : []),
  );
  downloadCsv(
    filename,
    fields.map(([name]) => name),
    table.allRows.map((row) => fields.map(([, value]) => value(row))),
  );
}
