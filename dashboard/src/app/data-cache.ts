import { ResponseCache } from '../lib/response-cache.js';

// Opt-in data only. This module never writes to browser storage.
export const cacheLimits = {
  entries: 80,
  bytes: 4 * 1024 * 1024,
  freshMs: 30_000,
  preloadConcurrent: 2,
  preloadQueued: 24,
  preloadDelayMs: 120,
};
export const dataCache = new ResponseCache(cacheLimits);
