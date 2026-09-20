import { api } from './api.js';
import { cacheLimits, dataCache } from './data-cache.js';

// Selected records load immediately; this small queue only warms likely next selections.
const queue = new Map<string, number>();
let running = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function drain() {
  timer = undefined;
  if (document.hidden) return;
  while (running < cacheLimits.preloadConcurrent && queue.size) {
    const [url, generation] = queue.entries().next().value!;
    queue.delete(url);
    if (generation !== dataCache.generation) continue;
    running++;
    void dataCache
      .read(url, (signal) => api(url, undefined, signal))
      .catch(() => {}) // An optional preload must not interrupt the page; selection retries it.
      .finally(() => {
        running--;
        schedule();
      });
  }
}

function schedule() {
  if (!timer && queue.size && !document.hidden)
    timer = setTimeout(drain, cacheLimits.preloadDelayMs);
}

export function prefetchData(urls: string[]) {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '')) return;
  for (const url of urls) {
    if (queue.size >= cacheLimits.preloadQueued) break;
    queue.set(url, dataCache.generation);
  }
  schedule();
}

document.addEventListener('visibilitychange', schedule);
