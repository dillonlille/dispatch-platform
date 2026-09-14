import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';

export function DspActionsMenu({ name, children }: { name: string; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const element = details.current!;
    const trigger = element.querySelector('summary')!;
    const menu = element.querySelector<HTMLElement>('.account-popover')!;
    // Keep the popup outside table clipping while anchoring it to this row.
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      if (
        anchor.bottom < 0 ||
        anchor.top > window.innerHeight ||
        anchor.right < 0 ||
        anchor.left > window.innerWidth
      ) {
        element.open = false;
        return;
      }
      const width = menu.offsetWidth,
        height = menu.offsetHeight;
      const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
      const below = anchor.bottom + 4;
      const top =
        below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 4);
      Object.assign(menu.style, { left: `${left}px`, top: `${top}px`, visibility: 'visible' });
    };
    const dismiss = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) element.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        element.open = false;
        trigger.focus();
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      menu.style.visibility = 'hidden';
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <details
      ref={details}
      className="row-menu"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={`Actions for ${name}`}>
        <Ellipsis size={18} />
      </summary>
      <div
        className="account-popover"
        onClick={() => {
          if (details.current) details.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
