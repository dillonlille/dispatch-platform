import { beginBrowserWrite } from './browser-update.js';
import { scheduleIssues } from './schedule-issues.js';
import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import { parseApiResponse } from '../../../shared/contracts/runtime.js';
import { backoff } from '../lib/backoff.js';
import { dataCache } from './data-cache.js';
export let csrf = '',
  view = '';
export function credentials(nextCsrf: string, nextView = '') {
  if (csrf !== nextCsrf || view !== nextView) dataCache.clear();
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
  meal_sync_scope_required: 'Complete your DSP profile with a station code to sync Flex.',
  cortex_station_unavailable:
    'Your saved station was not found in Cortex. Check your DSP profile and Cortex access.',
  cortex_provider_ambiguous:
    'Cortex could not identify your DSP. Check your DSP name and abbreviation.',
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
  connection_required: 'Connect Paycom before starting a collection.',
  last_owner_required: 'Keep at least one DSP owner.',
  dsp_view_expired: 'Your DSP access changed. Refreshing your view…',
  role_exceeds_permissions: 'You can only manage roles and members within your own permissions.',
  role_in_use: 'Move this role’s members and pending invitations to another role first.',
  role_name_taken: 'Another role already uses this name.',
  invalid_role_name: 'Choose a role name up to 40 characters. “Owner” is reserved.',
  role_not_found: 'This role no longer exists. Refresh and try again.',
  role_limit: 'You can create up to 50 roles for this DSP.',
  owner_role_locked: 'The Owner role cannot be changed.',
  verification_incomplete:
    'Paycom still needs verification. Complete the CAPTCHA, then press Submit again.',
  connection_busy: 'The browser is busy. Please try again in a moment.',
  verification_expired: 'Verification expired. Check the connection to start again.',
  browser_capacity: 'Browser capacity is full. Try again shortly.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  invalid_credentials: 'The provider could not verify those credentials.',
};
export function errorLabel(code: string): string | undefined {
  return labels[code];
}
export async function api<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const finish = body === undefined ? undefined : beginBrowserWrite();
  const requestView = view;
  try {
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
      if (value.error === 'dsp_view_expired' && url !== '/api/session/dsp')
        window.dispatchEvent(new Event('dispatch-view-expired'));
      throw new ApiError(
        value.error,
        errorLabel(value.error) ?? value.message ?? 'The request could not be completed.',
        response.status,
        response.headers.get('x-request-id') ?? undefined,
      );
    }
    try {
      const parsed = parseApiResponse(url, body === undefined ? 'GET' : 'POST', value) as T;
      if (body !== undefined && requestView === view) dataCache.invalidate();
      return parsed;
    } catch {
      throw new ApiError(
        'invalid_api_response',
        'The server returned an unexpected response. Refresh and try again.',
        502,
        response.headers.get('x-request-id') ?? undefined,
      );
    }
  } finally {
    finish?.();
  }
}
/** Opt in to bounded session memory and background revalidation. */
export function useCachedData<T>(url: string, poll = 0, refreshKey?: string | null) {
  return useData<T>(url, poll, refreshKey, url, true);
}

export function useData<T>(
  url: string,
  poll = 0,
  refreshKey?: string | null,
  dataScope?: string,
  cache = false,
) {
  const cached = useSyncExternalStore(
    useCallback(
      (listener) => (cache ? dataCache.subscribe(url, listener) : () => {}),
      [cache, url],
    ),
    useCallback(() => (cache ? dataCache.peek(url) : undefined), [cache, url]),
  );
  const generation = cached?.generation ?? 0;
  const session = cache ? dataCache.session : 0;
  const scope = cache ? url : dataScope;
  const previous = useRef<{ url: string; refreshKey?: string | null; revision: number }>(undefined);
  const [result, setResult] = useState<{ data: T; scope: string | undefined; session: number }>(),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    const changed = previous.current;
    const force =
      changed?.url === url && (changed.refreshKey !== refreshKey || changed.revision !== revision);
    previous.current = { url, refreshKey, revision };
    const controller = new AbortController();
    let active = true;
    setError('');
    let reading = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = async (force = false) => {
      if (!url || reading || document.hidden) return;
      reading = true;
      try {
        const value = cache
          ? await dataCache.read(url, (signal) => api<T>(url, undefined, signal), force)
          : await api<T>(url, undefined, controller.signal);
        if (active && (!cache || generation === dataCache.generation)) {
          setResult({ data: value, scope, session });
          setError('');
          failures = 0;
          if (retry) clearTimeout(retry);
        }
      } catch (error) {
        if (
          active &&
          (!cache || generation === dataCache.generation) &&
          error instanceof Error &&
          error.name !== 'AbortError'
        ) {
          setError(error.message);
          // A missed table response must recover even when no further driver arrives.
          if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) {
            if (retry) clearTimeout(retry);
            retry = setTimeout(() => void read(true), backoff(failures++));
          }
        }
      } finally {
        reading = false;
      }
    };
    const visible = () => {
      if (!document.hidden) void read(true);
    };
    document.addEventListener('visibilitychange', visible);
    void read(force);
    // Active cached views periodically revalidate, including changes made in another browser.
    const interval = poll || (cache ? dataCache.limits.freshMs : 0);
    const timer = interval ? setInterval(() => void read(true), interval) : undefined;
    return () => {
      active = false;
      controller.abort();
      document.removeEventListener('visibilitychange', visible);
      if (timer) clearInterval(timer);
      if (retry) clearTimeout(retry);
    };
  }, [url, revision, poll, refreshKey, scope, cache, generation, session]);
  // A date-scoped view can keep its controls mounted without showing the previous day's rows.
  const shown = result?.session === session ? result : undefined;
  const data =
    (cached?.data as T | undefined) ?? (shown?.scope === scope ? shown?.data : undefined);
  // The previous scope's value lets a view hold its layout, marked busy, until the new one lands.
  const stale = data || error ? undefined : shown?.data;
  return { data, stale, error, refresh };
}
