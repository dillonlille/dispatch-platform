import { useLayoutEffect, useRef } from 'react';

/** Fit a panel into its frame after responsive layout, including error and font changes. */
export function useViewportFit() {
  const frame = useRef<HTMLElement>(null);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const outer = frame.current,
      inner = panel.current;
    if (!outer || !inner) return;
    const fit = () => {
      const style = getComputedStyle(outer);
      const available =
        outer.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const scale = Math.min(1, Math.max(0, available) / Math.max(1, inner.offsetHeight));
      inner.style.setProperty('--viewport-fit', String(scale));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    observer.observe(inner);
    fit();
    return () => observer.disconnect();
  }, []);
  return { frame, panel };
}
