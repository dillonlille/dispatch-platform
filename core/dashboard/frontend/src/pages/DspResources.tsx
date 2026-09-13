import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { request } from "@/lib/api";
import { ErrorNotice, Loading } from "@/components/shared";

type Storage = {
  status: "measuring" | "ready" | "stale" | "unavailable";
  sampledAt?: number | null;
  refreshing?: boolean;
  limited?: boolean;
  usedBytes?: number;
  capacityBytes?: number | null;
  availableBytes?: number | null;
  runtimeBytes?: number;
  dataBytes?: number;
  pluginBytes?: number;
  logBytes?: number;
  localBackupBytes?: number;
  backups?: { available: boolean; count: number; bytes: number; manual: number; updates: number; plugins: number; lastAt: string | null };
};
type RuntimeView = {
  enabled: boolean;
  sampledAt: number;
  storageAvailableBytes: number | null;
  runtimes: { reference: string; name: string; status: string; cpuPercent: number | null; memoryBytes: number | null;
    tasks: number | null; activeWorkers: number | null; storage: Storage }[];
};
function bytes(value?: number | null) {
  if (value == null) return "Unavailable";
  if (value < 1024) return `${value} B`;
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** power).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
}
function age(at: number | null | undefined, now: number) {
  if (at == null) return "Waiting for measurement";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
function Metric({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return <div className="min-w-0 space-y-1"><dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    {children && <dd className="text-xs text-muted-foreground space-y-1">{children}</dd>}
  </div>;
}
export function DspResources() {
  const { session } = useSession();
  const [viewerId] = useState(() => crypto.randomUUID());
  const [visible, setVisible] = useState(() => !document.hidden);
  const [now, setNow] = useState(Date.now);
  const scanOnOpen = useRef(true);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);
  useEffect(() => {
    const leave = () => { void request("/api/platform/runtime", { method: "POST", keepalive: true,
      headers: { "X-Dispatch-CSRF": session.csrfToken || "" }, body: JSON.stringify({ viewerId, action: "close" }),
    }).catch(() => {}); };
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden) leave(); else scanOnOpen.current = true;
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [viewerId, session.csrfToken]);
  const runtime = useQuery({ queryKey: ["platform-runtime"], queryFn: ({ signal }) => {
    const refresh = scanOnOpen.current;
    scanOnOpen.current = false;
    return request<RuntimeView>(`/api/platform/runtime?viewer=${viewerId}${refresh ? "&refreshStorage=1" : ""}`, { signal });
  }, enabled: visible, refetchInterval: 2000, refetchOnMount: "always", refetchIntervalInBackground: false });
  const data = runtime.data;
  const stale = Boolean(runtime.error || (data && now - data.sampledAt > 10000));
  return <section aria-label="DSP resources" className="space-y-4 mb-8">
    <div className="flex flex-wrap justify-between items-start gap-3">
      <div><h2 className="text-lg font-semibold">DSP resources</h2><p className="text-sm text-muted-foreground">CPU and RAM refresh every 2 seconds while this page is visible. Storage and backups are checked when you open it.</p></div>
      <p role="status" className="flex items-center gap-2 text-sm"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${stale ? "bg-amber-400" : data?.enabled ? "bg-emerald-400" : "bg-muted-foreground"}`} />{stale ? "Live updates interrupted" : data?.enabled ? "Live" : "Connecting"}</p>
    </div>
    <ErrorNotice error={runtime.error} />
    {runtime.isPending && <Loading />}
    {data?.enabled === false && <p className="text-sm text-muted-foreground">Resource monitoring is unavailable on this installation.</p>}
    {data?.enabled && <>
      <p className="text-xs text-muted-foreground">Measured {age(data.sampledAt, now)} · Host storage available: {bytes(data.storageAvailableBytes)}{stale ? " · Showing last received measurements" : ""}</p>
      {data.runtimes.map(item => {
        const storage = item.storage, backup = storage?.backups;
        const storageStale = storage?.status === "stale";
        return <article key={item.reference} aria-label={`${item.name} resources`} className="rounded-xl border bg-card p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold break-words min-w-0">{item.name}</h3><span className="text-xs rounded-full bg-muted px-2.5 py-1 capitalize">{item.status}</span></div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6">
            <Metric label="CPU" value={item.cpuPercent == null ? "Measuring / unavailable" : `${item.cpuPercent.toFixed(1)}%`}><p>100% equals one CPU core</p></Metric>
            <Metric label="RAM" value={bytes(item.memoryBytes)}><p>{item.tasks ?? "—"} tasks · {item.activeWorkers ?? "—"} plugin / browser workers</p></Metric>
            <Metric label="DSP storage" value={bytes(storage?.usedBytes)}>
              {storage?.limited && <p>{bytes(storage.capacityBytes)} capacity · {bytes(storage.availableBytes)} free</p>}
              <p>Data {bytes(storage?.dataBytes)} · Plugins {bytes(storage?.pluginBytes)}</p>
              <p>Logs {bytes(storage?.logBytes)} · Local backups {bytes(storage?.localBackupBytes)}</p>
              <p>Runtime code: {bytes(storage?.runtimeBytes)} separately</p>
            </Metric>
            <Metric label="Backups" value={backup?.available ? String(backup.count) : "Unavailable"}>
              {backup?.available && <><p>{bytes(backup.bytes)} of backup data</p><p>{backup.manual} manual · {backup.updates} update · {backup.plugins} plugin rollback</p><p>{backup.lastAt ? `Latest: ${new Date(backup.lastAt).toLocaleString()}` : "No completed backups"}</p></>}
            </Metric>
          </dl>
          <p className="border-t pt-3 text-xs text-muted-foreground">Storage and backups: {storage?.status === "measuring" ? "Measuring…" : storage?.status === "unavailable" ? "Measurement unavailable" : `${age(storage?.sampledAt, now)}${storageStale ? " · Stale measurement" : ""}${storage?.refreshing ? " · Refreshing…" : ""}`}</p>
        </article>;
      })}
      {!data.runtimes.length && <p className="text-sm text-muted-foreground">No DSP runtimes yet.</p>}
      <p className="text-xs text-muted-foreground">CPU and RAM include each DSP’s runtime and isolated plugin and browser workers. Shared Core services and centrally stored dashboards are excluded. Backup totals include manual backups, update snapshots and plugin rollback copies; these can overlap local storage usage.</p>
    </>}
  </section>;
}
