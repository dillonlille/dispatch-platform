import { useCallback } from 'react';

/** Keep the real header in its table so horizontal scrolling, sizing and sorting stay native. */
export function useStickyTableHeader(enabled: boolean) {
  return useCallback(
    (table: HTMLTableElement | null) => {
      const header = table?.tHead;
      if (!enabled || !table || !header) return;
      const banner = document.querySelector<HTMLElement>('[data-sticky-banner]');
      let frame = 0;
      let offset = 0;
      const update = () => {
        frame = 0;
        const rect = header.getBoundingClientRect();
        const top = rect.top - offset;
        const pinnedTop = Math.max(0, banner?.getBoundingClientRect().bottom ?? 0);
        const next = Math.max(
          0,
          Math.min(pinnedTop - top, table.getBoundingClientRect().bottom - rect.height - top),
        );
        if (next === offset) return;
        offset = next;
        header.style.setProperty('--table-header-offset', `${offset}px`);
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(update);
      };
      // Overflow wrappers capture CSS sticky positioning even when only scrolling sideways.
      // Translate within the table instead, stopping at its bottom and below any pinned banner.
      const resize = new ResizeObserver(schedule);
      for (const element of [table, header, banner, document.body])
        if (element) resize.observe(element);
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);
      update();
      return () => {
        cancelAnimationFrame(frame);
        resize.disconnect();
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        header.style.removeProperty('--table-header-offset');
      };
    },
    [enabled],
  );
}
