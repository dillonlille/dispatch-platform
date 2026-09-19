import type { ReactNode } from 'react';

export function DetailList({
  items,
  className = 'detail-list',
}: {
  items: [string, ReactNode][];
  className?: string;
}) {
  return (
    <dl className={className}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
