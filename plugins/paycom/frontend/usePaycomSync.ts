import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { idempotent, request } from "dispatch-sdk/ui";

export type SyncSummary = {
  queuedRequest?: { id: string; status: string; error: string | null } | null;
  activeRun?: { id: string; status: string } | null;
  activity: string;
  desiredState: string;
  lastSucceededAt: string | number | null;
  nextDueAt: string | number | null;
  lastError: string | null;
  alerts: Array<{ code: string }>;
};
type SyncRequest = {
  sync?: SyncSummary;
  run?: { id: string; status: string } | null;
};
const active = new Set([
  "queued",
  "waiting_for_capacity",
  "syncing",
  "stopping",
]);

export function usePaycomSync(scope: string) {
  const cache = useQueryClient();
  const pending = useRef<Promise<SyncRequest> | null>(null);
  const lastSuccess = useRef<SyncSummary["lastSucceededAt"]>(null);
  const requestedAfter = useRef<SyncSummary["lastSucceededAt"]>(null);
  const query = useQuery({
    queryKey: ["paycom-sync", scope],
    queryFn: ({ signal }) =>
      request<SyncSummary>("/api/paycom/sync", { signal }),
    refetchInterval: 5000,
  });
  const run = useMutation({
    mutationFn: () => {
      if (!pending.current) {
        requestedAfter.current = query.data?.lastSucceededAt ?? null;
        pending.current = idempotent<SyncRequest>(
          `paycom-sync:${scope}`,
          "/api/paycom/sync",
          {},
        ).finally(() => {
          pending.current = null;
        });
      }
      return pending.current;
    },
    onSuccess: () =>
      cache.invalidateQueries({ queryKey: ["paycom-sync", scope] }),
  });
  const sync = query.data;
  useEffect(() => {
    if (!sync?.lastSucceededAt || sync.lastSucceededAt === lastSuccess.current)
      return;
    lastSuccess.current = sync.lastSucceededAt;
    for (const key of ["paycom-day", "paycom-employees", "paycom-employee"]) {
      void cache.invalidateQueries({ queryKey: [key, scope] });
    }
  }, [sync?.lastSucceededAt, cache, scope]);
  const busy = Boolean(sync && active.has(sync.activity));
  const authentication =
    !busy &&
    sync?.alerts?.some((alert) => alert.code === "authentication_blocked");
  const completed = Boolean(
    run.isSuccess &&
    sync?.lastSucceededAt &&
    sync.lastSucceededAt !== requestedAfter.current,
  );
  const message = run.isPending
    ? "Requesting sync…"
    : run.isSuccess && busy
      ? "Sync is in progress. Paycom will sign in automatically if needed."
      : completed
        ? "Sync completed."
        : run.isSuccess && authentication
          ? "Paycom could not finish signing in. You can retry with Sync now or check your connection settings."
          : run.isSuccess && sync?.lastError
            ? "Sync could not finish. Click Sync now to retry."
            : run.isSuccess
              ? "Sync requested. Paycom will sign in automatically if needed."
              : null;
  return { query, run, busy, authentication, message };
}
