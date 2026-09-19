import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={28} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
