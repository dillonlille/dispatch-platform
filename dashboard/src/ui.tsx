import { dateFormatter } from '../../shared/date-format.js';
import { useEffect, useRef, useId, type ReactNode } from 'react';
import { X, LoaderCircle, Inbox } from 'lucide-react';
import { displayTimezone } from './preferences.js';
export const time = (value: string | null | undefined) =>
  value
    ? dateFormatter('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: displayTimezone(),
      }).format(new Date(value))
    : 'Never';
export const title = (value: string) =>
  value
    .replaceAll('_', ' ')
    .replaceAll('.', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className={`status-indicator ${value}`}>
      <i />
      {children ?? title(value === 'ready' ? 'connected' : value)}
    </span>
  );
}
export function Tabs({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  items: string[][];
  label: string;
}) {
  return (
    <div className="restored-tabs" role="tablist" aria-label={label}>
      {items.map(([id, text], index) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          tabIndex={value === id ? 0 : -1}
          onKeyDown={(event) => {
            const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (!offset && !['Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index + offset + items.length) % items.length;
            onChange(items[next]![0]!);
            (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
          }}
          onClick={() => onChange(id!)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
export function Header({ title: label, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{label}</h1>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function Empty({ title: label, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={28} />
      <h3>{label}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} /> Loading…
    </div>
  );
}
export function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
}
export function Section({
  title: label,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{label}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Modal({
  title: label,
  children,
  onClose,
  variant = 'dialog',
  description,
}: {
  title: ReactNode;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  variant?: 'dialog' | 'sheet' | 'browser';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const body = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input,button,select')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
          ) ?? [],
        );
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = body;
      document.removeEventListener('keydown', key);
      before?.focus();
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${variant === 'sheet' ? 'sheet-backdrop' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${variant === 'sheet' ? 'side-sheet' : variant === 'browser' ? 'browser-modal' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="modal-heading" data-slot={variant === 'sheet' ? 'sheet-header' : undefined}>
          <h2 id={headingId}>{label}</h2>
          {description && <p className="muted">{description}</p>}
          {variant !== 'sheet' && (
            <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
              <X size={20} />
            </button>
          )}
        </div>
        {variant === 'sheet' ? <div className="panel-body">{children}</div> : children}
        {variant === 'sheet' && (
          <button className="sheet-close" aria-label="Close dialog" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
