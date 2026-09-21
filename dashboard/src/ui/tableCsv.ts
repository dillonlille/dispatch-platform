import { downloadCsv } from '../lib/csv.js';
import type { DataTable, TableColumn } from './useDataTable.js';

const columnName = <T>(column: TableColumn<T>) =>
  column.name ?? (typeof column.header === 'string' ? column.header : column.id);

/** Exports every row the table holds, in the order shown. */
export function downloadTable<T>(table: DataTable<T>, filename: string) {
  const fields = table.columns.flatMap(
    (column) =>
      column.exports ?? (column.value ? [[columnName(column), column.value] as const] : []),
  );
  downloadCsv(
    filename,
    fields.map(([name]) => name),
    table.allRows.map((row) => fields.map(([, value]) => value(row))),
  );
}
