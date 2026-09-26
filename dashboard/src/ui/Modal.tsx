import { useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from './useFocusTrap.js';

export function Modal({
  title,
  children,
  onClose,
  variant = 'dialog',
  description,
  dismissible = true,
  initialFocus = 'input,button,select',
}: {
  title: ReactNode;
  description?: string;
  dismissible?: boolean;
  initialFocus?: string;
  children: ReactNode;
  onClose: () => void;
  variant?: 'dialog' | 'sheet' | 'browser';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const dismiss = () => {
    if (dismissible) onClose();
  };
  useFocusTrap(ref, { initialFocus, onEscape: dismiss });
  return (
    <div
      className={`modal-backdrop ${variant === 'sheet' ? 'sheet-backdrop' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
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
          {variant !== 'sheet' && dismissible && (
            <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
              <X size={20} />
            </button>
          )}
        </div>
        {variant === 'sheet' ? <div className="panel-body">{children}</div> : children}
        {variant === 'sheet' && dismissible && (
          <button className="sheet-close" aria-label="Close dialog" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
