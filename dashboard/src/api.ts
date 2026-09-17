import { useEffect, useState, useCallback } from 'react';
export let csrf = '',
  view = '';
export function credentials(nextCsrf: string, nextView = '') {
  csrf = nextCsrf;
  view = nextView;
}
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const labels: Record<string, string> = {
  meal_sync_paycom_required: 'Connect Paycom before syncing meal breaks.',
  meal_sync_flex_required: 'Connect Cortex in Settings → Connections before syncing Flex.',
  meal_sync_scope_required: 'Flex needs an initial station collection before syncing this date.',
  sync_in_progress: 'A collection is already in progress. Wait for it to finish, then sync again.',
  queue_full: 'The collection queue is full. Try again after the current collections finish.',
  invalid_date: 'Choose a valid date that is not in the future.',
  settings_changed_reload_before_saving:
    'These settings changed in another session. Discard your draft and try again.',
  connect_paycom_before_automatic_sync: 'Connect Paycom before turning on automatic sync.',
  employee_already_linked:
    'A Paycom employee can only link to one Flex driver. Review duplicate selections.',
  employee_link_source_missing:
    'This employee is no longer available. Refresh and review the links again.',
  invalid_login: 'The email or password is incorrect.',
  permission_denied: 'Your role does not allow this action.',
  view_changed: 'Your DSP access changed. Reopen the DSP to continue.',
  stale_view: 'Your DSP access changed. Reopen the DSP to continue.',
  connection_required: 'Connect Paycom before starting a collection.',
  last_owner_required: 'Keep at least one DSP owner.',
  verification_incomplete:
    'Paycom still needs verification. Complete the CAPTCHA, then press Submit again.',
  connection_busy: 'The browser is busy. Please try again in a moment.',
  verification_expired: 'Verification expired. Check the connection to start again.',
  browser_capacity: 'Browser capacity is full. Try again shortly.',
  preview_test_required: 'Test this release on the Dev DSP first.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  invalid_credentials: 'The provider could not verify those credentials.',
};
export async function api<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}),
      ...(view ? { 'X-Dispatch-View': view } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/auth/login')
      window.dispatchEvent(new Event('dispatch-signed-out'));
    throw new ApiError(
      value.error,
      labels[value.error] ?? value.message ?? 'The request could not be completed.',
      response.status,
    );
  }
  return value as T;
}
export function useData<T>(url: string, poll = 0, refreshKey?: string | null) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setError('');
    let reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const value = await api<T>(url, undefined, controller.signal);
        if (active) {
          setData(value);
          setError('');
        }
      } catch (error) {
        if (active && error instanceof Error && error.name !== 'AbortError')
          setError(error.message);
      } finally {
        reading = false;
      }
    };
    const visible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener('visibilitychange', visible);
    void read();
    const timer = poll ? setInterval(() => void read(), poll) : undefined;
    return () => {
      active = false;
      controller.abort();
      document.removeEventListener('visibilitychange', visible);
      if (timer) clearInterval(timer);
    };
  }, [url, revision, poll, refreshKey]);
  return { data, error, refresh };
}
