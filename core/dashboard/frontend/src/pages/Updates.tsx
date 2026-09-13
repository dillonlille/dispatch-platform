import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle, CheckCircle2, CircleAlert, LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { idempotent, queryClient, request } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ErrorNotice, Loading, Notice, PageHeading } from "@/components/shared";
import { ManagedPage } from "./ManagedPage";

type Product = "core" | "dsp";
type Release = { id: string; digest: string; version: string; notes: string; publishedAt: string | null;
  url: string | null; source: { commit: string } | null };
type Track = { installedLegacy?: boolean; latest: string | null; installedVersion: string | null; installedDigest: string | null;
  release: Release | null; history: { id: string; version: string }[]; tested: boolean; canUpdate: boolean };
type UpdatesView = { platformRelease?: {version:string;changes:Record<"core"|"dsp"|"plugins",string>;url:string}; platformHistory?: {id:string;version:string}[]; latestPlatform?: string; mode: string; enabled: boolean; busy: boolean; worker: { available: boolean; status: string };
  dev: { name: string; available: boolean }; recoveryRequired: boolean;
  operation: { product: Product; phase: string; dspName: string | null } | null;
  tracks: Record<Product, Track>;
  rollout: { version: string; status: string; failure: string | null; updated: number; total: number;
    members: { name: string; status: string }[] } | null;
  jobs: { id: string; action: string; product: Product; status: string; failure: string | null }[] };
const failureText: Record<string, string> = {
  release_changed: "A newer release is available. Review it and try again.",
  release_dev_required: "Install the latest release on Dev before starting rollout.",
  release_dsp_not_ready: "This DSP needs to be running and finish setup before it can be updated.",
  release_health_failed: "Health checks failed. The previous version was restored.",
  release_recovery_required: "The update needs recovery before another update can start.",
  release_interrupted: "The update worker restarted. Review the state before continuing.",
  release_baseline_required: "The installed version must be registered before updates can begin.",
  release_fleet_changed: "The DSP list changed. Review it and start rollout again.",
  release_verification_failed: "The release could not be verified. Check the worker’s GitHub connection and retry.",
  release_runtime_not_ready: "A DSP runtime did not pass its readiness check. Review its runtime status before retrying the update.",
  release_backup_unsafe: "The DSP backup check found a file it could not safely copy. Resolve the backup issue before retrying.",
};
const actionNames: Record<string, string> = {
  refresh: "Release check", update_core: "Core update", update_dev: "Dev update",
  rollout: "Rollout", pause: "Pause request", resume: "Resume request", recover: "Update recovery",
};
const phases: Record<string, string> = {
  preparing: "Preparing the update", draining: "Stopping services and backing up private data",
  starting: "Installing the release and checking service health", restoring: "Restoring the previous version",
  failed: "Recovery is required before updates can continue",
};
function Spinner() {
  return <span className="inline-flex shrink-0 motion-safe:animate-spin" aria-hidden="true"><LoaderCircle className="size-4" /></span>;
}
export function Updates({ hash }: { hash: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: string; product: Product; id?: string } | null>(null);
  const sending = pending !== null;
  const [error, setError] = useState<unknown>(null);
  const query = useQuery({ queryKey: ["independent-updates", selected],
    queryFn: () => request<UpdatesView>(`/api/platform/updates${selected ? `?releaseId=${encodeURIComponent(selected)}` : ""}`),
    refetchInterval: 3000 });
  const view = query.data;
  const initialCore = useRef<string | null | undefined>(undefined);
  const coreDigest = view?.tracks?.core.installedDigest;
  useEffect(() => {
    if (pending?.id && view?.jobs?.some(job => job.id === pending.id)) setPending(null);
  }, [pending, view?.jobs]);
  useEffect(() => {
    if (view?.mode !== "independent") return;
    const previous = initialCore.current;
    initialCore.current = coreDigest;
    if (previous !== undefined && coreDigest && previous !== coreDigest) window.location.reload();
  }, [view?.mode, coreDigest]);
  if (view && view.mode !== "independent") return <ManagedPage page="updates" hash={hash} />;
  async function command(action: string, digest: string | null = null, product: Product = "core") {
    if (sending) return;
    setPending({ action, product }); setError(null);
    try {
      const updated = await idempotent<UpdatesView>(`updates:${action}:${product}:${digest}`, "/api/platform/updates", { action, product, digest });
      const job = updated.jobs.find(item => item.action === action && item.product === product);
      setPending(job ? { action, product, id: job.id } : null);
      await queryClient.invalidateQueries({ queryKey: ["independent-updates"] });
    } catch (cause) { setError(cause); setPending(null); }
  }
  const activeJob = view?.jobs.find(job => ["queued", "running"].includes(job.status));
  const lastJob = view?.jobs[0];
  const updatingCore = activeJob?.action === "update_core" || view?.operation?.product === "core";
  const rolloutActive = view?.rollout?.status === "running";
  let status: { title: string; detail: string; tone: "working" | "success" | "attention" } | null = null;
  if (pending) status = { title: pending.id ? "Request received" : `Sending ${actionNames[pending.action]?.toLowerCase() || "update request"}…`,
    detail: pending.id ? "Waiting for the worker’s latest status. You can leave this page and return to check progress." : "Submitting your request. Please wait.", tone: "working" };
  else if (view?.operation) status = { title: view.operation.product === "core" ? "Updating Core" : `Updating ${view.operation.dspName || view.dev.name}`,
    detail: `${phases[view.operation.phase] || "Applying the update"}.${rolloutActive ? ` ${view.rollout!.updated} of ${view.rollout!.total} DSPs updated.` : ""}`,
    tone: ["failed", "restoring"].includes(view.operation.phase) ? "attention" : "working" };
  else if (activeJob) status = { title: `${actionNames[activeJob.action] || "Update"} ${activeJob.status === "queued" ? "queued" : "in progress"}`,
    detail: activeJob.status === "queued" ? "Waiting for the update worker to start." : ["rollout", "update_dev", "update_core", "refresh"].includes(activeJob.action)
      ? "Checking the release and preparing the update. This can take a few minutes. Progress updates automatically."
      : "The worker is processing your request. Progress updates automatically.", tone: "working" };
  else if (lastJob?.status === "failed") status = { title: `${actionNames[lastJob.action] || "Update"} failed`,
    detail: failureText[lastJob.failure || ""] || "The request could not finish. Review the current state, then retry or recover.", tone: "attention" };
  else if (view?.rollout && (view.rollout.status !== "completed" || !lastJob || ["rollout", "resume", "pause"].includes(lastJob.action))) status = { title: rolloutActive ? "Rolling out update" : view.rollout.status === "completed" ? "Rollout complete" : "Rollout paused",
    detail: `${view.rollout.updated} of ${view.rollout.total} DSPs updated.${rolloutActive ? " DSPs update one at a time. You can leave this page and return to check progress." : view.rollout.status === "paused" ? " Review rollout progress below before resuming." : " All DSPs in this rollout are on the selected release."}`,
    tone: rolloutActive ? "working" : view.rollout.status === "completed" ? "success" : "attention" };
  else if (lastJob?.status === "completed") status = { title: `${actionNames[lastJob.action] || "Update"} complete`,
    detail: lastJob.action === "update_dev" ? "Dev passed installation checks. Test the changes in Dev before choosing Rollout Update." : "The worker finished your request.", tone: "success" };
  if (status?.tone === "working" && (query.isError || view && !view.worker.available)) status = { title: "Waiting for update status",
    detail: updatingCore ? "Core is restarting. This page will reconnect automatically." : "The latest progress is temporarily unavailable. This page will keep checking; your update may still be running.", tone: "attention" };
  return <>
    <PageHeading title="Updates" description="Choose when Core and your DSPs receive new releases.">
      <Button variant="outline" disabled={sending || view?.busy || !view?.worker.available}
        onClick={() => void command("refresh")}>{(pending?.action || activeJob?.action) === "refresh" ? <Spinner /> : <RefreshCw aria-hidden="true" />}Check for updates</Button>
    </PageHeading>
    <ErrorNotice error={error || (!updatingCore ? query.error : null)} />
    {status && <section aria-label="Update status" role="status" aria-live="polite" aria-atomic="true" className="mb-5 flex items-start gap-3 rounded-xl border bg-card p-5">
      <span className="mt-1 text-primary">{status.tone === "working" ? <Spinner /> : status.tone === "success" ? <CheckCircle2 className="size-5" aria-hidden="true" /> : <CircleAlert className="size-5" aria-hidden="true" />}</span>
      <div className="min-w-0 space-y-1"><h2 className="font-semibold">{status.title}</h2><p className="text-sm text-muted-foreground">{status.detail}</p></div>
    </section>}
    {query.isPending ? <Loading /> : view ? <div className="space-y-5" id="platform-updates-content">
      {!view.enabled && <Notice>Updates need initial setup. Your current services will continue running.</Notice>}
      {view.enabled && !view.worker.available && <Notice error>The update worker is offline. Releases remain available to read.</Notice>}
      {view.recoveryRequired && !activeJob && <div className="rounded-xl border bg-card p-5 space-y-3">
        <p>Recover the interrupted update before installing another release.</p>
        <Button disabled={sending || !view.worker.available} onClick={() => void command("recover")}>Recover update</Button>
      </div>}
      {view.platformRelease && <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">Release {view.platformRelease.version}</h2>
        <label className="text-sm">Release history <select aria-label="Release history" className="rounded-md border bg-background px-3 py-2"
          value={selected || `platform_${view.latestPlatform}`} onChange={event=>setSelected(event.target.value)}>
          {[...(view.platformHistory||[])].reverse().map(item=><option key={item.id} value={item.id}>{item.version}</option>)}
        </select></label>
      </div>}
      <div className="space-y-5">
        {(["core", "dsp"] as const).map(trackName => {
          const track = view.tracks[trackName], release = track.release;
          const latestSelected = Boolean(release && release.digest === track.latest && (!view.platformRelease || view.platformRelease.version === view.latestPlatform));
          const rolling = view.rollout && view.rollout.status !== "completed";
          const action = trackName === "core" ? "update_core" : track.tested ? "rollout" : "update_dev";
          const label = trackName === "core" ? "Update Core" : track.tested ? "Rollout Update" : "Update Dev";
          const working = pending?.product === trackName && pending.action !== "refresh" || activeJob?.product === trackName && activeJob.action !== "refresh" || view.operation?.product === trackName || trackName === "dsp" && rolloutActive;
          const workingLabel = pending?.product === trackName ? pending.id ? "Request received…" : "Sending request…"
            : activeJob?.status === "queued" && activeJob.product === trackName ? "Update queued…"
            : activeJob?.action === "pause" ? "Pausing rollout…" : activeJob?.action === "resume" ? "Resuming rollout…" : activeJob?.action === "recover" ? "Recovering update…"
            : trackName === "core" ? "Updating Core…" : rolloutActive ? "Rolling out…" : activeJob?.action === "rollout" ? "Preparing rollout…" : "Updating Dev…";
          return <div key={trackName} className="space-y-5">
            <section className="rounded-xl border bg-card p-6 space-y-5" aria-label={`${trackName === "core" ? "Core" : "DSP"} release`}>
              <div className="flex flex-wrap justify-between items-start gap-4">
                <div className="space-y-1"><h2 className="text-xl font-semibold">{trackName === "core" ? "Core" : "DSP"}</h2>
                  <p className="text-sm text-muted-foreground">{trackName === "core" ? "Installed" : `Installed on ${view.dev.name}`}: {track.installedVersion || "Not registered"}{track.installedLegacy ? " (legacy release)" : ""}</p></div>
                <Button disabled={sending || view.busy || Boolean(working) || !track.canUpdate || !latestSelected || (trackName === "dsp" && (!view.dev.available || Boolean(rolling)))}
                  onClick={() => void command(action, track.latest, trackName)}>{working ? <Spinner /> : <ArrowUpCircle aria-hidden="true" />}{working ? workingLabel : trackName === "core" && track.installedDigest === track.latest ? "Core up to date" : label}</Button>
              </div>
              <p className="text-sm text-muted-foreground">{trackName === "core"
                ? "Updates the Platform Owner dashboard, shared API and Core services."
                : track.tested ? "Dev has passed installation checks. Test the changes, then roll this version out to your DSPs one at a time."
                  : "Install this version on the permanent Dev DSP first. Your other DSPs receive it when you start rollout."}</p>
              <div className="border-t pt-5 space-y-4">
                {release ? <><div className="flex flex-wrap justify-between gap-3 items-baseline">
                  <h3 className="text-lg font-semibold">Version {release.version}</h3>
                  {release.url && <a className="text-sm underline underline-offset-4" href={release.url} target="_blank" rel="noreferrer">View release on GitHub</a>}
                </div><div className="whitespace-pre-wrap break-words text-sm leading-7" aria-label="Changelog">{view.platformRelease ? view.platformRelease.changes[trackName] || "No changes." : release.notes}</div>
                  {!latestSelected && <p className="text-sm text-muted-foreground">You’re reading a previous release. Select the latest version to update.</p>}
                </> : <p className="text-sm text-muted-foreground">No verified releases yet.</p>}
              </div>
            </section>
            {trackName === "dsp" && view.rollout && <section className="rounded-xl border bg-card p-6 space-y-4" aria-label="Rollout progress">
              <div className="flex flex-wrap justify-between gap-3 items-center"><h2 className="text-lg font-semibold">Rollout · {view.rollout.version}</h2>
                {view.rollout.status === "running" && <Button variant="outline" disabled={sending || !view.worker.available} onClick={() => void command("pause", null, "dsp")}><Pause aria-hidden="true" />Pause rollout</Button>}
                {view.rollout.status === "paused" && <Button disabled={sending || view.recoveryRequired || !view.worker.available || Boolean(activeJob)} onClick={() => void command("resume", null, "dsp")}><Play aria-hidden="true" />Resume rollout</Button>}
              </div>
              <p className="text-sm text-muted-foreground">{view.rollout.updated} of {view.rollout.total} DSPs updated · {view.rollout.status}</p>
              {view.rollout.status === "paused" && <Notice>The rollout is paused. Resolve the affected DSP before resuming this version.</Notice>}
              <progress aria-label="DSPs updated" value={view.rollout.updated} max={Math.max(1, view.rollout.total)} className="w-full accent-primary" />
              <ul className="divide-y">{view.rollout.members.map((member, index) => <li key={index} className="flex justify-between gap-4 py-3 text-sm"><span className="min-w-0 break-words">{member.name}</span><span className="flex shrink-0 items-center gap-2 text-muted-foreground">{member.status === "updating" && <Spinner />}{member.status === "updated" && <CheckCircle2 className="size-4" aria-hidden="true" />}{member.status}</span></li>)}</ul>
            </section>}
          </div>;
        })}
        <section className="rounded-xl border bg-card p-6 space-y-4" aria-label="Plugins release">
          <h2 className="text-xl font-semibold">Plugins</h2>
          <p className="text-sm text-muted-foreground">Included in the DSP update. Test on Dev before rolling out to other DSPs.</p>
          <div className="whitespace-pre-wrap break-words text-sm leading-7" aria-label="Plugin changelog">{view.platformRelease?.changes.plugins || "See the DSP release notes for plugin changes."}</div>
        </section>
      </div>
    </div> : null}
  </>;
}
