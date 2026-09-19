import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** A `<details>` menu that closes on Escape, on a press outside it, and once an item is chosen. */
export function Popover({
  label,
  trigger,
  children,
  className,
  triggerClassName,
  anchored = false,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  className: string;
  triggerClassName?: string;
  /** Places the panel against the viewport so a scrolling or clipping ancestor cannot cut it off. */
  anchored?: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const element = details.current!;
    const summary = element.querySelector('summary')!;
    const menu = panel.current!;
    const place = () => {
      const anchor = summary.getBoundingClientRect();
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
    if (anchored) {
      place();
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, { capture: true, passive: true });
    }
    return () => {
      if (anchored) {
        menu.style.visibility = 'hidden';
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
      }
    };
  }, [open, anchored]);
  // The browser opens the menu before its toggle event reaches React, so these listen from
  // the start and read the element: a key pressed in that gap still closes it.
  useEffect(() => {
    const element = details.current!;
    const dismiss = (event: PointerEvent) => {
      if (element.open && !element.contains(event.target as Node)) element.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !element.open) return;
      element.open = false;
      element.querySelector('summary')!.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return (
    <details
      ref={details}
      className={className}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={triggerClassName} aria-label={label}>
        {trigger}
      </summary>
      <div
        ref={panel}
        className="account-popover"
        onClick={() => {
          details.current!.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
