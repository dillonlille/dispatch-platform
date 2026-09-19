import type { ReactNode } from 'react';
import { title } from '../lib/format.js';

export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className={`status-indicator ${value}`}>
      <i />
      {children ?? title(value === 'ready' ? 'connected' : value)}
    </span>
  );
}
