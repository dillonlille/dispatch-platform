import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { idempotent, queryClient, request } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PageHeading, ErrorNotice, Loading, Notice } from "@/components/shared";

import { DspResources } from "./DspResources";

type DiagnosticsView = {
  enabled: boolean;
  dsps: {
    name: string;
    createdAt: string;
    status: string;
    installation: { state: string };
  }[];
};

export function Diagnostics() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const data = useQuery({
    queryKey: ["platform-diagnostics"],
    queryFn: () => request<DiagnosticsView>("/api/platform/diagnostics"),
    refetchInterval: 5000,
  });
  async function deploy() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await idempotent<DiagnosticsView>(
        "diagnostics-create",
        "/api/platform/diagnostics",
        {},
      );
      queryClient.setQueryData(["platform-diagnostics"], next);
      await queryClient.invalidateQueries({ queryKey: ["fleet"] });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Diagnostics"
        description="Monitor DSP resources and create test DSPs."
      />
      <ErrorNotice error={error || data.error} />
      <DspResources />
      {data.isPending ? (
        <Loading />
      ) : data.data ? (
        <div className="space-y-6">
          <section
            className="rounded-xl border bg-card p-6 space-y-4"
            aria-labelledby="test-dsp-title"
          >
            <h2 id="test-dsp-title" className="text-lg font-semibold">
              Test DSP
            </h2>
            <p className="text-sm text-muted-foreground">
              Deploy a DSP with synthetic employees and timecards. It stays
              available until you delete it from DSPs. Provider collection stays
              stopped, and no invitation email is sent.
            </p>
            <Button onClick={deploy} disabled={busy || !data.data.enabled}>
              <FlaskConical aria-hidden="true" />
              {busy ? "Requesting test DSP…" : "Deploy test DSP"}
            </Button>
            {!data.data.enabled ? (
              <Notice>
                Test DSP deployment is unavailable on this installation.
              </Notice>
            ) : null}
          </section>
          <section
            aria-label="Test DSP deployments"
            className="space-y-3"
            aria-live="polite"
          >
            {data.data.dsps.map((dsp) => (
              <div key={dsp.name} className="rounded-xl border p-4">
                <h3 className="font-medium">{dsp.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {dsp.status === "pending"
                    ? "Creating DSP and preparing synthetic data…"
                    : dsp.status === "failed"
                      ? "Setup needs attention. Open DSPs to inspect or delete this test DSP."
                      : `Synthetic data prepared · ${dsp.installation.state === "ready" ? "Available" : dsp.installation.state}`}
                </p>
              </div>
            ))}
          </section>
          <a href="#/platform" className="text-sm underline">
            Manage test DSPs in DSPs
          </a>
        </div>
      ) : null}
    </>
  );
}
