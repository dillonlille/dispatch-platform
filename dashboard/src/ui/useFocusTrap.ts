import { useEffect, useRef, type RefObject } from 'react';

const focusable =
  'a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';
// Open traps, innermost last: only the topmost one answers keys.
const open: symbol[] = [];

/** Holds focus inside `container` while active, locks page scroll, and restores focus after. */
export function useFocusTrap(
  container: RefObject<HTMLElement | null>,
  {
    active = true,
    initialFocus = focusable,
    onEscape,
  }: { active?: boolean; initialFocus?: string; onEscape: () => void },
) {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  }, [onEscape]);
  useEffect(() => {
    if (!active) return;
    const trap = Symbol('focus-trap');
    open.push(trap);
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const visible = (selector: string) =>
      Array.from(container.current?.querySelectorAll<HTMLElement>(selector) ?? []).filter(
        (element) => element.getClientRects().length > 0,
      );
    visible(initialFocus)[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || open.at(-1) !== trap) return;
      if (event.key === 'Escape') escape.current();
      if (event.key === 'Tab') {
        const elements = visible(focusable);
        const first = elements[0],
          last = elements.at(-1);
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
      open.splice(open.indexOf(trap), 1);
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', key);
      before?.focus();
    };
  }, [active, container, initialFocus]);
}
