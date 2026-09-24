import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createExpandedRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ExpandedState,
  type RowData,
  type Row,
} from '@tanstack/react-table';

// The only module that knows the table engine. Pages describe columns and rows in the
// terms below, so a capability added here reaches every table without touching a page.
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});
type Features = typeof features;

export type TableSort = { id: string; desc: boolean };

/** Where a table keeps what the person chose. The page decides how long each part lasts. */
export interface TableStateStore {
  sort: TableSort | null;
  setSort: (sort: TableSort) => void;
  page: number;
  setPage: (page: number) => void;
}

/** What a cell or row renderer can know about the row beyond its data. */
export interface RowContext {
  /** 0 for a row of `rows`, 1 for a row returned by `subRows`. */
  depth: number;
  expanded: boolean;
  toggle: () => void;
}

export interface TableColumn<T> {
  id: string;
  header: ReactNode;
  /** Plain name for exports. Defaults to `header` when that is text. */
  name?: string;
  cell: (row: T, context: RowContext) => ReactNode;
  /** A comparable value read from the row alone. Required for client sorting; used by exports. */
  value?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  /** Replaces the sort button's class and arrow. */
  sortHeader?: { className?: string; indicator?: (direction: 'asc' | 'desc') => ReactNode };
  /** Renders the cell as `<th scope="row">`. */
  rowHeader?: boolean;
  scope?: 'col';
  className?: string | ((row: T, context: RowContext) => string | undefined);
  headerClassName?: string;
  dataLabel?: string;
  /** Keeps the column in view while the table scrolls sideways on a narrow screen. */
  sticky?: boolean;
  /** Export columns, when one cell holds more than one value. Defaults to `name` and `value`. */
  exports?: [name: string, value: (row: T) => string | number | null | undefined][];
}

export interface DataTableOptions<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowId: (row: T, index: number) => string;
  /** Omit for a table whose choices need not outlive the component. */
  state?: TableStateStore;
  /** `server` trusts the order of `rows` and leaves the request to the page. */
  sorting?: 'client' | 'server';
  /** Rows per page. Omit to show every row. */
  pageSize?: number;
  /** Set when `rows` is one page the server already cut from this many rows. */
  total?: number;
  /** Rows shown beneath an expanded row. They sort and page with their parent. */
  subRows?: (row: T) => T[] | undefined;
  /** Ids of the rows that start expanded. Read once, when the table is first drawn. */
  expanded?: string[];
}

export interface DataTable<T> {
  columns: TableColumn<T>[];
  /** The rows to draw, sub-rows of expanded rows included. */
  rows: { id: string; data: T; context: RowContext }[];
  /** Every row in display order, ignoring pages. One server page when `total` is set. */
  allRows: T[];
  sort: TableSort | null;
  toggleSort: (id: string) => void;
  page: number;
  pageSize: number;
  total: number;
  setPage: (page: number) => void;
  collapseAll: () => void;
}

const compare = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a ?? '').localeCompare(String(b ?? ''));
const everything = Number.MAX_SAFE_INTEGER;

function useLocalState(): TableStateStore {
  const [sort, setSort] = useState<TableSort | null>(null);
  const [page, setPage] = useState(0);
  return { sort, setSort, page, setPage };
}

export function useDataTable<T extends RowData>({
  columns,
  rows,
  rowId,
  state: given,
  sorting = 'client',
  pageSize = everything,
  total,
  subRows,
  expanded: startExpanded,
}: DataTableOptions<T>): DataTable<T> {
  const local = useLocalState();
  const state = given ?? local;
  const [expanded, setExpanded] = useState<ExpandedState>(() =>
    Object.fromEntries((startExpanded ?? []).map((id) => [id, true])),
  );
  // Pages may rebuild `columns` on every render. The engine only needs new definitions when
  // a column's identity or abilities change, and reads values through the latest columns.
  const latest = useRef(columns);
  latest.current = columns;
  const shape = columns.map((column) => `${column.id}:${Boolean(column.sortable)}`).join('|');
  const defs = useMemo(
    () =>
      latest.current.map((column, index): ColumnDef<Features, T> => ({
        id: column.id,
        accessorFn: (row) => latest.current[index]?.value?.(row) ?? null,
        enableSorting: Boolean(column.sortable),
        sortFn: (a: Row<Features, T>, b: Row<Features, T>, id: string) =>
          compare(a.getValue(id), b.getValue(id)),
      })),
    [shape],
  );
  const count = total ?? rows.length;
  // A page left over from a longer list falls back to the last page that still has rows.
  const page = Math.min(state.page, Math.max(0, Math.ceil(count / pageSize) - 1));
  const table = useTable({
    features,
    columns: defs,
    data: rows,
    getRowId: rowId,
    getSubRows: subRows,
    getRowCanExpand: () => true,
    paginateExpandedRows: false,
    manualSorting: sorting === 'server',
    manualPagination: total !== undefined,
    rowCount: total,
    enableSortingRemoval: false,
    enableMultiSort: false,
    autoResetPageIndex: false,
    autoResetExpanded: false,
    state: {
      sorting: state.sort ? [state.sort] : [],
      pagination: { pageIndex: page, pageSize },
      expanded,
    },
    onExpandedChange: (next) =>
      setExpanded((current) => (typeof next === 'function' ? next(current) : next)),
  });
  return {
    columns,
    rows: table.getRowModel().rows.map((row) => ({
      id: row.id,
      data: row.original,
      context: {
        depth: row.depth,
        expanded: row.getIsExpanded(),
        toggle: () => row.toggleExpanded(),
      },
    })),
    allRows: table.getPrePaginatedRowModel().rows.map((row) => row.original),
    sort: state.sort,
    toggleSort: (id) => {
      state.setSort({ id, desc: state.sort?.id === id && !state.sort.desc });
      state.setPage(0);
    },
    page,
    pageSize,
    total: count,
    setPage: state.setPage,
    collapseAll: () => setExpanded({}),
  };
}
