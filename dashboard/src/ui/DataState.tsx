import type { ReactNode } from 'react';
import { ErrorBox } from './ErrorBox.js';
import { Loading } from './Loading.js';

/**
 * The one loading rule: no data yet means a spinner, data (even stale, beside an
 * error) means content. Pass `error` to show it above; a caller that already
 * shows it elsewhere passes `failed` instead where the spinner should stop.
 */
export function DataState<T>({
  data,
  error = '',
  failed = false,
  children,
}: {
  data: T | undefined;
  error?: string;
  failed?: boolean;
  children: (data: T) => ReactNode;
}) {
  return (
    <>
      <ErrorBox message={error} />
      {data === undefined ? !failed && <Loading /> : children(data)}
    </>
  );
}
