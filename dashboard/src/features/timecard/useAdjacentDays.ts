import { useEffect, useRef } from 'react';
import { prefetchData } from '../../app/prefetch.js';
import { addDays } from '../../lib/calendar.js';

/** Warm only the previous and next day, using the current filters and sort. */
export function useAdjacentDays(url: string, date: string, today: string, loaded?: object) {
  const warmed = useRef('');
  useEffect(() => {
    if (!loaded || warmed.current === url) return;
    warmed.current = url;
    prefetchData(
      [-1, 1]
        .map((offset) => addDays(date, offset))
        .filter((day) => day <= today)
        .map((day) => url.replace(`date=${date}`, `date=${day}`)),
    );
  }, [url, date, today, loaded]);
}
