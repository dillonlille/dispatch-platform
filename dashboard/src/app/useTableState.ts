import type { TableSort, TableStateStore } from '../ui/index.js';
import { useUpdateState } from './browser-update.js';

/**
 * The state of one table: it belongs to the visit and survives only an update reload.
 * `name` must be unique among the tables a page can show.
 */
export function useTableState(name: string, sort: TableSort | null = null): TableStateStore {
  const [currentSort, setSort] = useUpdateState<TableSort | null>(`${name}-sort`, sort);
  const [page, setPage] = useUpdateState(`${name}-page`, 0);
  return { sort: currentSort, setSort, page, setPage };
}
