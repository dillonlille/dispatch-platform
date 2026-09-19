import type { ReactNode } from 'react';
import { ArrowUpDown } from 'lucide-react';

export function SortHeader({
  children,
  direction,
  onSort,
  scope,
  className = 'table-sort',
  indicator = <ArrowUpDown size={14} />,
}: {
  children: ReactNode;
  /** Omit when the table is sorted by another column. */
  direction?: 'asc' | 'desc';
  onSort: () => void;
  scope?: 'col';
  className?: string;
  indicator?: ReactNode;
}) {
  return (
    <th
      scope={scope}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button className={className} onClick={onSort}>
        {children}
        {indicator}
      </button>
    </th>
  );
}
