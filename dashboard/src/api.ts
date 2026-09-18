import { scheduleIssues } from '../../shared/schedules.js';
import { useEffect, useState, useCallback } from 'react';
import { parseApiResponse } from '../../shared/contracts/runtime.js';
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
    readonly requestId?: string,
  ) {
    super(message);
  }
}
const labels: Record<string, string> = {
  ...scheduleIssues,
  schedule_changed: 'This schedule changed in another session. Reload it before saving.',
  schedule_not_found: 'This schedule was deleted. Close the editor and refresh.',
  schedule_limit: 'You can create up to 50 schedules for this DSP.',
  invalid_schedule_time: 'Choose a valid collection time.',
  invalid_schedule_interval: 'Choose an interval from 0.5 to 24 hours in half-hour increments.',
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
  email_unavailable: 'Email sending is not configured for this environment.',
  invitation_expired: 'This invitation has expired or was revoked. Ask for a new invitation.',
  sign_in_with_existing_password: 'Use your existing Dispatch password to accept this invitation.',
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
      response.headers.get('x-request-id') ?? undefined,
    );
  }
  try {
    return parseApiResponse(url, body === undefined ? 'GET' : 'POST', value) as T;
  } catch {
    throw new ApiError(
      'invalid_api_response',
      'The server returned an unexpected response. Refresh and try again.',
      502,
      response.headers.get('x-request-id') ?? undefined,
    );
  }
}
export function useData<T>(url: string, poll = 0, refreshKey?: string | null, dataScope?: string) {
  const [result, setResult] = useState<{ data: T; scope: string | undefined }>(),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setError('');
    let reading = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!url || reading || document.hidden) return;
      reading = true;
      try {
        const value = await api<T>(url, undefined, controller.signal);
        if (active) {
          setResult({ data: value, scope: dataScope });
          setError('');
          failures = 0;
          if (retry) clearTimeout(retry);
        }
      } catch (error) {
        if (active && error instanceof Error && error.name !== 'AbortError') {
          setError(error.message);
          // A missed table response must recover even when no further driver arrives.
          if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) {
            if (retry) clearTimeout(retry);
            retry = setTimeout(
              () => void read(),
              Math.min(15000, 1000 * 2 ** Math.min(failures++, 4)),
            );
          }
        }
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
      if (retry) clearTimeout(retry);
    };
  }, [url, revision, poll, refreshKey, dataScope]);
  // A date-scoped view can keep its controls mounted without showing the previous day's rows.
  const data = result?.scope === dataScope ? result?.data : undefined;
  return { data, error, refresh };
}
