import { Columns3 } from 'lucide-react';
import { Popover } from './Popover.js';
import type { DataTable, TableColumn } from './useDataTable.js';

export const columnName = <T,>(column: TableColumn<T>) =>
  column.name ?? (typeof column.header === 'string' ? column.header : column.id);

/** Lets a person choose which columns a table shows. */
export function ColumnMenu<T>({ table }: { table: DataTable<T> }) {
  return (
    <Popover
      className="row-menu column-menu"
      label="Choose columns"
      trigger={<Columns3 size={16} />}
      anchored
    >
      {/* A choice here keeps the menu open, so several columns can change at once. */}
      <fieldset onClick={(event) => event.stopPropagation()}>
        <legend>Columns</legend>
        {table.columns
          .filter((column) => column.hideable !== false)
          .map((column) => (
            <label key={column.id}>
              <input
                type="checkbox"
                checked={!table.isHidden(column.id)}
                onChange={() => table.toggleColumn(column.id)}
              />
              {columnName(column)}
            </label>
          ))}
      </fieldset>
    </Popover>
  );
}
