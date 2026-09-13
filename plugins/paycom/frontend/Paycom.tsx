import { useEffect, useState } from "react";
import {
  ArrowRight,
  CircleCheck,
  CircleHelp,
  Info,
  LoaderCircle,
  Plug,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  activeMembership,
  isDspOwner,
  mutation,
  request,
} from "dispatch-sdk/ui";
import { useSession } from "dispatch-sdk/ui";
import { useTimezone } from "dispatch-sdk/ui";
import { dateTime } from "dispatch-sdk/ui";
import { Button } from "dispatch-sdk/ui";
import { Badge } from "dispatch-sdk/ui";
import { PaycomWorkforce } from "./PaycomWorkforce.tsx";
import { PaycomSettings } from "./PaycomSettings.tsx";
import { ErrorNotice, Loading, Notice, PageHeading } from "dispatch-sdk/ui";

type Connection = {
  status:
    "not_started" | "enrolling" | "queued" | "running" | "succeeded" | "failed";
  failureCode: string | null;
  canSubmit: boolean;
  canRetry: boolean;
  retryState?: string | null;
  retryAt?: string | null;
  workforceAvailable: boolean;
};
const pending = (status?: string) =>
  ["enrolling", "queued", "running"].includes(status || "");
const connectionCopy = {
  not_started: {
    label: "Not connected",
    title: "Connect your Paycom account",
    description:
      "Paycom is not connected. You can keep using your DSP and connect it later.",
    icon: CircleHelp,
  },
  enrolling: {
    label: "Connecting",
    title: "Your connection is in progress",
    description:
      "Verifying your Paycom login. You can leave this page while it finishes.",
    icon: LoaderCircle,
  },
  queued: {
    label: "Connecting",
    title: "Your connection is in progress",
    description:
      "Verifying your Paycom login. You can leave this page while it finishes.",
    icon: LoaderCircle,
  },
  running: {
    label: "Connecting",
    title: "Your connection is in progress",
    description:
      "Verifying your Paycom login. You can leave this page while it finishes.",
    icon: LoaderCircle,
  },
  succeeded: {
    label: "Connected",
    title: "Your Paycom account is connected",
    description:
      "Your Paycom login is verified. Workforce data has not been imported.",
    icon: CircleCheck,
  },
  failed: {
    label: "Needs attention",
    title: "Let’s get Paycom connected",
    description:
      "Paycom could not finish connecting. Your DSP is still ready to use.",
    icon: TriangleAlert,
  },
} as const;
export function Paycom() {
  const { session } = useSession();
  const [settings, setSettings] = useState(() =>
    new URLSearchParams(location.hash.split("?")[1] || "").has("settings"),
  );
  useEffect(() => {
    const changed = () =>
      setSettings(
        new URLSearchParams(location.hash.split("?")[1] || "").has("settings"),
      );
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  if (settings)
    return isDspOwner(session) ? (
      <PaycomSettings />
    ) : (
      <Notice>Your DSP owner can manage Paycom settings.</Notice>
    );
  return <PaycomContent />;
}
function PaycomContent() {
  const { timeZone } = useTimezone();
  const { session } = useSession();
  const membership = activeMembership(session);
  const owner = isDspOwner(session);
  const connection = useQuery({
    queryKey: ["paycom-connection", membership?.organizationId],
    queryFn: ({ signal }) =>
      request<Connection>("/api/organization/paycom-setup", { signal }),
    enabled: owner,
    refetchInterval: (q) => {
      const value = q.state.data;
      if (pending(value?.status)) return 2000;
      // Recovery happens outside this page; observe it without submitting a login.
      return value?.status === "failed" ? 5000 : false;
    },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const state = connection.data;
  const needsSetup =
    state?.status !== "succeeded" && !state?.workforceAvailable;
  // Share the Settings connection cache and read the broker's current result.
  // The onboarding job also prepares collections; it is not a login status.
  const credentials = useQuery({
    queryKey: ["connections", membership?.organizationId],
    queryFn: ({ signal }) =>
      request<{ items: { service: string; state: string }[] }>(
        "/api/organization/connections",
        { signal },
      ),
    enabled: owner && needsSetup,
    refetchInterval: pending(state?.status) ? 2000 : 5000,
  });
  const verified = credentials.data?.items.some(
    (item) => item.service === "paycom" && item.state === "connected",
  );
  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await mutation("/api/organization/paycom-setup/retry", "POST", {});
      await connection.refetch();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const copy = state ? connectionCopy[state.status] : null;
  const StatusIcon = copy?.icon || CircleHelp;
  if (!owner || state?.status === "succeeded" || state?.workforceAvailable)
    return <PaycomWorkforce />;
  if (verified && state)
    return (
      <PaycomWorkforce
        setupNotice={
          <>
            <Notice>
              <p>
                {pending(state.status)
                  ? "Paycom is connected. Preparing workforce sync. Timecards and employees will appear after the first collection."
                  : "Paycom is connected, but workforce setup has not finished."}
              </p>
              {state.canRetry ? (
                <Button disabled={busy} variant="outline" onClick={retry}>
                  Retry workforce setup
                </Button>
              ) : !pending(state.status) ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    location.hash = "#/settings?tab=connections";
                  }}
                >
                  Connection settings
                </Button>
              ) : null}
            </Notice>
            <ErrorNotice error={error || connection.error} />
          </>
        }
      />
    );
  return (
    <div className="paycom-page">
      <PageHeading
        title="Paycom"
        description="Connect Paycom to verify your login."
      />
      {!owner ? (
        <Notice>Your DSP owner can manage the Paycom connection.</Notice>
      ) : (
        <>
          <ErrorNotice error={error || connection.error} />
          {connection.isPending ? (
            <Loading />
          ) : (
            state &&
            copy && (
              <section
                className="paycom-connection"
                aria-labelledby="paycom-connection-title"
              >
                <header className="paycom-connection-header">
                  <div className="paycom-connection-identity">
                    <div className="paycom-connection-icon" aria-hidden="true">
                      <Plug />
                    </div>
                    <div>
                      <h2 id="paycom-connection-title">Workforce connection</h2>
                      <p>Confirm that your Paycom login works.</p>
                    </div>
                  </div>
                  <Badge variant="secondary" role="status">
                    {state.status === "not_started" ? (
                      <span className="paycom-status-dot" aria-hidden="true" />
                    ) : (
                      <StatusIcon
                        aria-hidden="true"
                        className={
                          pending(state.status)
                            ? "motion-safe:animate-spin"
                            : undefined
                        }
                      />
                    )}
                    {copy.label}
                  </Badge>
                </header>
                <div className="paycom-connection-body">
                  <div className="paycom-connection-message" role="status">
                    <h3>{copy.title}</h3>
                    <p>{copy.description}</p>
                  </div>
                  {state.status === "failed" &&
                    (state.failureCode === "provider_auth_required" ? (
                      <Notice error>
                        Paycom could not verify your login. Retry the connection
                        or update your Paycom credentials.
                      </Notice>
                    ) : (
                      <ErrorNotice error={state.failureCode} />
                    ))}
                  {state.status === "failed" &&
                    state.retryState === "cooldown" &&
                    state.retryAt && (
                      <Notice>
                        Another attempt is available after{" "}
                        {dateTime(state.retryAt, timeZone)}.
                      </Notice>
                    )}
                  {state.status === "failed" &&
                    state.retryState === "unavailable" && (
                      <Notice>
                        Connection status is temporarily unavailable. Checking
                        again shortly.
                      </Notice>
                    )}
                  {state.status === "failed" && state.retryState === "busy" && (
                    <Notice>
                      Paycom is still finishing an operation. Checking again
                      shortly.
                    </Notice>
                  )}
                  {(state.canRetry || state.canSubmit) && (
                    <div className="paycom-connection-actions">
                      {state.canRetry && (
                        <Button
                          disabled={busy}
                          variant="outline"
                          onClick={retry}
                        >
                          <RotateCw
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          Retry connection
                        </Button>
                      )}
                      {state.canSubmit && (
                        <Button
                          size="lg"
                          disabled={busy}
                          onClick={() => {
                            location.hash = "#/settings?tab=connections";
                          }}
                        >
                          {state.status === "not_started"
                            ? "Connect Paycom"
                            : "Replace Paycom credentials"}
                          <ArrowRight
                            data-icon="inline-end"
                            aria-hidden="true"
                          />
                        </Button>
                      )}
                    </div>
                  )}
                  {state.canSubmit && state.status === "not_started" && (
                    <p className="paycom-connection-hint">
                      Have your client code, login, and five numbered security
                      PINs ready.
                    </p>
                  )}
                </div>
                <footer className="paycom-connection-footer">
                  <Info aria-hidden="true" />
                  <p>This is optional. Your DSP is ready to use.</p>
                </footer>
              </section>
            )
          )}
        </>
      )}
    </div>
  );
}
