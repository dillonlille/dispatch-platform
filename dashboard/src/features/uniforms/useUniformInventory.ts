import { useCallback, useEffect, useState } from 'react';
import type { UniformAdjustment, UniformInventory } from '../../../../shared/contracts/uniforms.js';
import { ApiError } from '../../app/api.js';
import { getUniformUpdates } from '../../app/endpoints.js';
import { backoff } from '../../lib/backoff.js';
import { messageOf } from '../../lib/errors.js';
import {
  applyUniformAdjustments,
  applyUniformSnapshot,
  applyUniformUpdates,
} from '../../lib/uniforms.js';

export type InventoryStatus = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'unavailable';

export function useUniformInventory(token: string) {
  const [data, setData] = useState<UniformInventory>();
  const [status, setStatus] = useState<InventoryStatus>('connecting');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  const accept = useCallback(
    (next: UniformInventory) => setData((current) => applyUniformSnapshot(current, next)),
    [],
  );
  const acknowledge = useCallback((change: UniformAdjustment) => {
    // Acknowledgements must not advance the stream cursor: other users' changes may precede them.
    setData((current) => current && applyUniformAdjustments(current, [change]));
  }, []);

  useEffect(() => {
    let disposed = false;
    let after: number | undefined;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const listen = async () => {
      if (disposed || document.hidden || controller || !navigator.onLine) return;
      const request = new AbortController();
      controller = request;
      let delay = 0;
      let stopped = false;
      try {
        const update = await getUniformUpdates(
          after,
          AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]),
        );
        if (disposed || request.signal.aborted) return;
        setData((current) => applyUniformUpdates(current, update));
        after = update.revision;
        failures = 0;
        setError('');
        setStatus('live');
      } catch (cause) {
        if (disposed || request.signal.aborted) return;
        stopped = cause instanceof ApiError && [401, 403].includes(cause.status);
        setError(messageOf(cause));
        setStatus(stopped ? 'unavailable' : 'reconnecting');
        after = undefined;
        delay = backoff(failures++);
      } finally {
        if (controller === request) controller = undefined;
        if (!disposed && !request.signal.aborted && !stopped && !document.hidden)
          retry = setTimeout(() => void listen(), delay);
      }
    };
    const resume = () => {
      if (retry) clearTimeout(retry);
      controller?.abort();
      controller = undefined;
      after = undefined;
      setStatus(document.hidden ? 'paused' : navigator.onLine ? 'connecting' : 'reconnecting');
      if (!document.hidden && navigator.onLine) void listen();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', resume);
    resume();
    return () => {
      disposed = true;
      controller?.abort();
      if (retry) clearTimeout(retry);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', resume);
    };
  }, [token, generation]);
  return { data, status, error, refresh, accept, acknowledge };
}
