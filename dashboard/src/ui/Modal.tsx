import { useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from './useFocusTrap.js';

export function Modal({
  title,
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
  useFocusTrap(ref, { initialFocus: 'input,button,select', onEscape: onClose });
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
          <h2 id={headingId}>{title}</h2>
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
