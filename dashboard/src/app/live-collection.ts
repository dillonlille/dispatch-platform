import { useEffect } from 'react';
import { ApiError, view } from './api.js';
import { backoff } from '../lib/backoff.js';
import { dataCache } from './data-cache.js';
import { collectionAffects, collectionData, type CollectionChange } from '../lib/data-policy.js';
import { getCollectionUpdates } from './endpoints.js';

/** One sleeping request for the Timecard page, shared across days and tabs. */
export function useCollectionUpdates() {
  const token = view;
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let after = '';
    let pendingVersion: string | undefined;
    let pendingChanges: CollectionChange[] = [];
    const refresh = (version: string, changes: CollectionChange[]) => {
      pendingVersion = version;
      pendingChanges.push(...changes);
      if (pending) return;
      // Coalesce closely spaced driver results from the collection lanes.
      pending = setTimeout(() => {
        pending = undefined;
        if (!disposed) {
          const changes = pendingChanges;
          pendingChanges = [];
          dataCache.observeVersion('collections', pendingVersion!, (url) =>
            collectionAffects(url, changes),
          );
        }
      }, 400);
    };
    const listen = async () => {
      if (disposed || document.hidden || !navigator.onLine || controller) return;
      const request = new AbortController();
      controller = request;
      let delay = 0;
      let stopped = false;
      try {
        const result = await getCollectionUpdates(
          after,
          AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
        );
        if (!request.signal.aborted && !disposed) {
          // Record the baseline before a fast first update can coalesce with it.
          if (after === '')
            dataCache.observeVersion('collections', result.revision, collectionData);
          else if (result.revision !== after) refresh(result.revision, result.changes);
          after = result.revision;
          failures = 0;
        }
      } catch (error) {
        if (!request.signal.aborted && !disposed) {
          stopped = error instanceof ApiError && [401, 403].includes(error.status);
          delay = backoff(failures++);
          // A transient transport failure still gets a conventional data refresh.
          if (!stopped && failures === 1) dataCache.invalidate(collectionData);
        }
      } finally {
        if (controller === request) controller = undefined;
        if (!disposed && !document.hidden && !stopped) retry = setTimeout(listen, delay);
      }
    };
    const visibility = () => {
      if (retry) clearTimeout(retry);
      if (document.hidden || !navigator.onLine) {
        controller?.abort();
        if (pending) clearTimeout(pending);
        pending = undefined;
        pendingChanges = [];
      } else {
        after = '';
        void listen();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', visibility);
    window.addEventListener('offline', visibility);
    void listen();
    return () => {
      disposed = true;
      controller?.abort();
      if (retry) clearTimeout(retry);
      if (pending) clearTimeout(pending);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', visibility);
      window.removeEventListener('offline', visibility);
    };
  }, [token]);
}
