import { useState } from 'react';
import { useFeedback } from './feedback.js';
import { messageOf } from '../lib/errors.js';

/**
 * A mutation with its busy and error state. Failures show at the top of the page
 * unless `inline`, where the caller renders `error` itself; `success` is toasted.
 */
export function useAction<A extends unknown[]>(
  work: (...args: A) => Promise<unknown>,
  {
    success,
    inline = false,
  }: { success?: string | ((...args: A) => string); inline?: boolean } = {},
) {
  const { perform, notify } = useFeedback();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function run(...args: A) {
    const message = typeof success === 'function' ? success(...args) : success;
    setBusy(true);
    setError('');
    try {
      if (!inline) return await perform(() => work(...args), message);
      await work(...args);
      if (message) notify(message);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error };
}
