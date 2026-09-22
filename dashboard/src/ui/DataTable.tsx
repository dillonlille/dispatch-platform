import type { KeyboardEvent, ReactNode } from 'react';
import { Pagination } from './Pagination.js';
import { SortHeader } from './SortHeader.js';
import { useStickyTableHeader } from './useStickyTableHeader.js';
import type { DataTable as Table, RowContext, TableColumn } from './useDataTable.js';

const classes = (...names: (string | false | undefined)[]) =>
  names.filter(Boolean).join(' ') || undefined;
const focusable = 'summary, button, a[href], input, select, [tabindex]:not([tabindex="-1"])';

// Arrow keys, and j and k, move between rows, keeping to the control in the same column.
function moveBetweenRows(event: KeyboardEvent<HTMLTableSectionElement>) {
  const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key];
  const target = event.target as HTMLElement;
  if (
    !step ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    (target.matches('input, select, textarea') && !target.matches('[type="checkbox"]'))
  )
    return;
  const cell = target.closest('td, th') as HTMLTableCellElement | null;
  let row = target.closest('tr');
  if (!cell || !row || row.parentElement !== event.currentTarget) return;
  while ((row = (step > 0 ? row.nextElementSibling : row.previousElementSibling) as typeof row)) {
    const next =
      row.cells[cell.cellIndex]?.querySelector<HTMLElement>(focusable) ??
      row.querySelector<HTMLElement>(focusable);
    if (!next) continue;
    event.preventDefault();
    next.focus();
    return;
  }
}

export function DataTable<T>({
  table,
  label,
  caption,
  className,
  stickyHeader = false,
  rowClassName,
  renderDetail,
  detailClassName,
}: {
  table: Table<T>;
  label?: string;
  /** Read by assistive technology only. */
  caption?: ReactNode;
  className?: string;
  /** Pin column headings during page scroll, below any data-sticky-banner element. */
  stickyHeader?: boolean;
  rowClassName?: (row: T, context: RowContext) => string | undefined;
  /** Drawn across the full width beneath an expanded row and its sub-rows. */
  renderDetail?: (row: T) => ReactNode;
  detailClassName?: string;
}) {
  const tableRef = useStickyTableHeader(stickyHeader);
  const columns = table.columns;
  const cellClass = (column: TableColumn<T>, row: T, context: RowContext) =>
    classes(
      typeof column.className === 'function' ? column.className(row, context) : column.className,
      column.sticky && 'sticky-column',
    );
  const detail = (row: { id: string; data: T }) => (
    <tr key={`${row.id}:detail`} className={detailClassName}>
      <td colSpan={columns.length}>{renderDetail!(row.data)}</td>
    </tr>
  );
  // An expanded row's detail follows its sub-rows, so it waits for the next top-level row.
  const body: ReactNode[] = [];
  let open: { id: string; data: T } | undefined;
  for (const row of table.rows) {
    if (!row.context.depth) {
      if (open) body.push(detail(open));
      open = renderDetail && row.context.expanded ? row : undefined;
    }
    body.push(
      <tr key={row.id} className={rowClassName?.(row.data, row.context)}>
        {columns.map((column) =>
          column.rowHeader ? (
            <th key={column.id} scope="row" className={cellClass(column, row.data, row.context)}>
              {column.cell(row.data, row.context)}
            </th>
          ) : (
            <td
              key={column.id}
              className={cellClass(column, row.data, row.context)}
              data-label={column.dataLabel}
            >
              {column.cell(row.data, row.context)}
            </td>
          ),
        )}
      </tr>,
    );
  }
  if (open) body.push(detail(open));
  return (
    <table
      ref={tableRef}
      className={classes(className, stickyHeader && 'table-sticky-header')}
      aria-label={label}
    >
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr>
          {columns.map((column) => {
            const direction =
              table.sort?.id === column.id ? (table.sort.desc ? 'desc' : 'asc') : undefined;
            return column.sortable ? (
              <SortHeader
                key={column.id}
                scope={column.scope}
                direction={direction}
                onSort={() => table.toggleSort(column.id)}
                className={column.sortHeader?.className}
                headerClassName={classes(column.headerClassName, column.sticky && 'sticky-column')}
                indicator={column.sortHeader?.indicator?.(direction ?? 'asc')}
              >
                {column.header}
              </SortHeader>
            ) : (
              <th
                key={column.id}
                scope={column.scope}
                className={classes(column.headerClassName, column.sticky && 'sticky-column')}
              >
                {column.header}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody onKeyDown={moveBetweenRows}>{body}</tbody>
    </table>
  );
}

/** The page controls for a table that set a page size. */
export function TablePagination<T>({
  table,
  variant,
}: {
  table: Table<T>;
  variant?: 'range' | 'pages';
}) {
  return (
    <Pagination
      page={table.page}
      pageSize={table.pageSize}
      total={table.total}
      onChange={table.setPage}
      variant={variant}
    />
  );
}
