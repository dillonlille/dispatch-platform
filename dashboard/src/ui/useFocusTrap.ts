import { useEffect, useRef, type RefObject } from 'react';

const focusable =
  'a[href],button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';
// Open traps, innermost last: only the topmost one answers keys.
const open: HTMLElement[] = [];

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
    const element = container.current;
    if (!element) return;
    open.push(element);
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const visible = (selector: string) =>
      Array.from(element.querySelectorAll<HTMLElement>(selector)).filter(
        (candidate) => candidate.getClientRects().length > 0,
      );
    visible(initialFocus)[0]?.focus();
    const key = (event: KeyboardEvent) => {
      while (open.length && !open.at(-1)?.isConnected) open.pop();
      if (event.defaultPrevented || open.at(-1) !== element) return;
      if (event.key === 'Escape') escape.current();
      if (event.key === 'Tab') {
        const elements = visible(focusable);
        const first = elements[0],
          last = elements.at(-1);
        const current = document.activeElement as HTMLElement | null;
        if (event.shiftKey && (current === first || !current || !elements.includes(current))) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (current === last || !current || !element.contains(current))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      const index = open.lastIndexOf(element);
      if (index >= 0) open.splice(index, 1);
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', key, true);
      before?.focus();
    };
  }, [active, container, initialFocus]);
}
