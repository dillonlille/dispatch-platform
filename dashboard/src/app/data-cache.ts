import { performancePolicy } from '../lib/performance-policy.js';
import { ResponseCache } from '../lib/response-cache.js';

// Opt-in data only. This module never writes to browser storage.
export const cacheLimits = {
  ...performancePolicy.cache,
  preloadConcurrent: 2,
  preloadQueued: 24,
  preloadDelayMs: 120,
};
export const dataCache = new ResponseCache(cacheLimits);
