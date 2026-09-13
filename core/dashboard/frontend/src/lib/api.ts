import { QueryClient } from "@tanstack/react-query";
import type { Session } from "./types.ts";
export class ApiError extends Error {
  constructor(
    public code: string,
    public status?: number,
  ) {
    super(code);
  }
}
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true, staleTime: 1000 },
    mutations: { retry: false },
  },
});
let currentSession: Session | null = null;
const viewStorageKey = "dispatch-dsp-view";
let viewRef = sessionStorage.getItem(viewStorageKey);
export function setDspView(value: string | null) {
  viewRef = value;
  if (value) sessionStorage.setItem(viewStorageKey, value);
  else sessionStorage.removeItem(viewStorageKey);
  queryClient.clear();
  keys.clear();
}
function authority(session: Session | null) {
  return JSON.stringify([
    session?.authenticated,
    session?.user?.id,
    session?.activeOrganizationId,
    session?.dspView?.viewRef,
    session?.platformPermissions,
    session?.memberships?.map((m) => [
      m.id,
      m.permissions,
      m.organization.status,
    ]),
  ]);
}
export function setSession(session: Session | null) {
  if (authority(currentSession) !== authority(session)) {
    queryClient.clear();
    keys.clear();
    window.dispatchEvent(new Event("dispatch-authority-changed"));
  }
  currentSession = session;
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const requestedView = viewRef;
  if (
    currentSession?.dspView &&
    !requestedView &&
    path !== "/api/auth/session"
  )
    // Polling can fire while the old DSP screen awaits the platform session.
    // Keep those reads scoped just like mutations during the transition.
    throw new ApiError("dsp_view_changed", 409);
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
      ...(requestedView ? { "X-Dispatch-DSP-View": requestedView } : {}),
    },
  });
  const value = await response.json().catch(() => null);
  if (requestedView !== viewRef) throw new ApiError("dsp_view_changed", 409);
  if (!response.ok || !value?.ok) {
    if (value?.error?.code === "dsp_view_unavailable" && requestedView) {
      setDspView(null);
      if (path !== "/api/auth/session")
        window.dispatchEvent(new Event("dispatch-dsp-view-ended"));
    }
    if (response.status === 401 && currentSession?.authenticated) {
      setDspView(null);
      setSession(null);
      window.dispatchEvent(new Event("dispatch-session-expired"));
    }
    throw new ApiError(value?.error?.code || "request_failed", response.status);
  }
  return value.data as T;
}
export function mutation<T>(
  path: string,
  method: string,
  body: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return request<T>(path, {
    signal: options.signal,
    method,
    headers: currentSession?.authenticated
      ? { "X-Dispatch-CSRF": currentSession.csrfToken! }
      : {},
    body: JSON.stringify(body),
  });
}
const keys = new Map<string, string>();
export function mutationKey(slot: string, prefix = slot) {
  if (!keys.has(slot))
    keys.set(slot, `dashboard:${prefix}:${crypto.randomUUID()}`);
  return keys.get(slot)!;
}
export function settleMutationKey(slot: string, error: unknown = null) {
  if (
    error === null ||
    (error instanceof ApiError &&
      error.status &&
      error.status >= 400 &&
      error.status < 500)
  )
    keys.delete(slot);
}
export async function idempotent<T>(
  slot: string,
  path: string,
  body: Record<string, unknown>,
) {
  try {
    const data = await mutation<T>(path, "POST", {
      ...body,
      idempotencyKey: mutationKey(slot, "request"),
    });
    settleMutationKey(slot);
    return data;
  } catch (error) {
    settleMutationKey(slot, error);
    throw error;
  }
}
export const has = (
  membership: { permissions: string[] } | null,
  permission: string,
) => Boolean(membership?.permissions.includes(permission));
export const isPlatform = (session: Session) =>
  !session.dspView &&
  Boolean(session.platformPermissions?.includes("platform.organizations.read"));
export const activeMembership = (session: Session) =>
  isPlatform(session)
    ? null
    : session.memberships?.find(
        (m) => m.organizationId === session.activeOrganizationId,
      ) || null;
export const isDspOwner = (session: Session) => {
  const membership = activeMembership(session);
  return membership?.roleKey === "owner" && has(membership, "organization.owner");
};
