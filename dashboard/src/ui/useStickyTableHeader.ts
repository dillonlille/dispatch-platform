import { useCallback } from 'react';

/** Fix the real heading row to the viewport; an inert row keeps its natural table sizing. */
export function useStickyTableHeader(enabled: boolean) {
  return useCallback(
    (table: HTMLTableElement | null) => {
      const header = table?.tHead?.rows[0];
      const placeholder = table?.tHead?.rows[1];
      const wrap = table?.parentElement;
      if (!enabled || !table || !header || !placeholder || !wrap) return;
      const banner = document.querySelector<HTMLElement>('[data-sticky-banner]');
      let frame = 0;
      let pinned = false;
      const set = (element: HTMLElement, property: string, value: string) => {
        if (element.style.getPropertyValue(property) !== value)
          element.style.setProperty(property, value);
      };
      const reset = () => {
        table.removeAttribute('data-header-pinned');
        header.removeAttribute('style');
        for (const cell of header.cells) cell.style.removeProperty('width');
        pinned = false;
      };
      const update = () => {
        frame = 0;
        const reference = pinned ? placeholder : header;
        const rect = reference.getBoundingClientRect();
        const tableRect = table.getBoundingClientRect();
        const pinnedTop = Math.max(0, banner?.getBoundingClientRect().bottom ?? 0);
        if (rect.top >= pinnedTop || tableRect.bottom <= pinnedTop) {
          if (pinned) reset();
          return;
        }
        const viewportLeft = wrap.getBoundingClientRect().left + wrap.clientLeft;
        const widths = Array.from(reference.cells, (cell) => cell.getBoundingClientRect().width);
        // Vertical position is fixed throughout scrolling; only the table's end pushes it away.
        // Horizontal clipping keeps the fixed row inside its original sideways scroll region.
        set(header, 'top', `${Math.min(pinnedTop, tableRect.bottom - rect.height)}px`);
        set(header, 'left', `${rect.left}px`);
        set(header, 'width', `${rect.width}px`);
        set(header, 'height', `${rect.height}px`);
        set(header, '--table-header-scroll', `${wrap.scrollLeft}px`);
        set(
          header,
          'clip-path',
          `inset(0 ${Math.max(0, rect.right - viewportLeft - wrap.clientWidth)}px 0 ${Math.max(0, viewportLeft - rect.left)}px)`,
        );
        for (const [index, cell] of Array.from(header.cells).entries())
          set(cell, 'width', `${widths[index]}px`);
        if (!pinned) {
          table.setAttribute('data-header-pinned', '');
          pinned = true;
        }
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(update);
      };
      const revealFocusedColumn = (event: FocusEvent) => {
        if (!pinned || !(event.target instanceof HTMLElement)) return;
        const cell = event.target.closest('th');
        if (!cell) return;
        const first = placeholder.cells[0]!;
        const stickyFirst = getComputedStyle(first).position === 'sticky';
        if (stickyFirst && cell.cellIndex === 0) return;
        const left = wrap.getBoundingClientRect().left + wrap.clientLeft;
        const start = left + (stickyFirst ? first.getBoundingClientRect().width : 0);
        const rect = cell.getBoundingClientRect();
        // A fixed control cannot ask its overflow ancestor to reveal it on keyboard focus.
        wrap.scrollLeft +=
          rect.left < start ? rect.left - start : Math.max(0, rect.right - left - wrap.clientWidth);
        schedule();
      };
      const resize = new ResizeObserver(schedule);
      for (const element of [table, placeholder, banner, document.body])
        if (element) resize.observe(element);
      window.addEventListener('scroll', schedule, { passive: true });
      wrap.addEventListener('scroll', schedule, { passive: true });
      header.addEventListener('focusin', revealFocusedColumn);
      window.addEventListener('resize', schedule);
      update();
      return () => {
        cancelAnimationFrame(frame);
        resize.disconnect();
        window.removeEventListener('scroll', schedule);
        wrap.removeEventListener('scroll', schedule);
        header.removeEventListener('focusin', revealFocusedColumn);
        window.removeEventListener('resize', schedule);
        reset();
      };
    },
    [enabled],
  );
}
