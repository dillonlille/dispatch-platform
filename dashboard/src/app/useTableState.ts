import { useState } from 'react';
import type { TableSort, TableStateStore } from '../ui/index.js';
import { useUpdateState } from './browser-update.js';

// Column choices belong to the person, on this device, until preferences are stored
// on the server. Sorting and the page belong to the visit and survive only an update reload.
let user = 'signed-out';
export function tablePreferencesFor(userId?: string) {
  user = userId ?? 'signed-out';
}
const key = (name: string) => `dispatch-table:${user}:${name}`;
function savedColumns(name: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(name)) ?? '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The state of one table. `name` must be unique among the tables a page can show. */
export function useTableState(name: string, sort: TableSort | null = null): TableStateStore {
  const [currentSort, setSort] = useUpdateState<TableSort | null>(`${name}-sort`, sort);
  const [page, setPage] = useUpdateState(`${name}-page`, 0);
  const [hidden, setHidden] = useState(() => savedColumns(name));
  return {
    sort: currentSort,
    setSort,
    page,
    setPage,
    hidden,
    setHidden: (next) => {
      setHidden(next);
      try {
        localStorage.setItem(key(name), JSON.stringify(next));
      } catch {
        // The choice still applies until the page reloads.
      }
    },
  };
}
