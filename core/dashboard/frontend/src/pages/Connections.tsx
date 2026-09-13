import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { useSession } from "@/lib/session";
import { useTimezone } from "@/lib/timezone";
import { dateTime } from "@/lib/date-time";
import {
  activeMembership,
  ApiError,
  isDspOwner,
  mutation,
  queryClient,
  request,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import {
  ErrorNotice,
  Loading,
  Notice,
  SubmitButton,
  TextField,
} from "@/components/shared";

type Service = {
  id: string;
  name: string;
  fields: { name: string; label: string; maximum: number }[];
};
type Connection = {
  service: string;
  configured: boolean;
  state:
    | "not_connected"
    | "not_verified"
    | "checking"
    | "connected"
    | "verification_required"
    | "credentials_rejected"
    | "temporarily_unavailable";
  reason: string | null;
  checkedAt: string | null;
  retryAt: string | null;
  verification?: { id: string; expiresAt: string; attemptsRemaining: number };
  assistance?: { phase: "queued" | "solving" | "verifying"; startedAt: string };
  check?: { phase: "checking_session" | "signing_in"; startedAt: string };
};
type ConnectionsData = { services: Service[]; items: Connection[] };
const labels: Record<Connection["state"], string> = {
  not_connected: "Not connected",
  not_verified: "Not verified",
  checking: "Checking connection",
  connected: "Connected",
  verification_required: "Verification required",
  credentials_rejected: "Credentials rejected",
  temporarily_unavailable: "Temporarily unavailable",
};
function connectionLabel(item: Connection) {
  if (item.state === "checking") {
    if (item.assistance) return "Completing CAPTCHA";
    if (item.check?.phase === "checking_session") return "Checking session";
    if (item.check?.phase === "signing_in") return "Signing in";
  }
  return labels[item.state];
}
function guidance(item: Connection) {
  if (item.assistance?.phase === "queued")
    return "Paycom requested a CAPTCHA. Waiting for automatic verification to start.";
  if (item.assistance?.phase === "solving")
    return "Completing Paycom’s CAPTCHA automatically. You can leave this page while verification finishes.";
  if (item.assistance?.phase === "verifying")
    return "Checking Paycom’s response before continuing.";
  if (item.check?.phase === "checking_session")
    return "Checking whether your saved Paycom session is still signed in.";
  if (item.check?.phase === "signing_in")
    return "Signing in to Paycom with your saved credentials and security answers.";
  if (item.reason === "verification_code_rejected")
    return "Amazon didn’t accept that code. Enter the newest code from your email.";
  if (item.reason === "verification_expired")
    return "This verification attempt ended. Test the connection to start a new sign-in.";
  if (item.verification && item.state !== "checking")
    return "Amazon sent you an email verification code. Enter it below to finish signing in.";
  if (item.reason === "attempt_cooldown")
    return "The service needs a pause before another login attempt. Retry after the time shown below.";
  if (item.service === "paycom" && item.reason === "captcha_required")
    return "Paycom requires a CAPTCHA before sign-in can finish. Contact your Dispatch administrator to complete verification. Connection tests will remain blocked until it is resolved.";
  if (item.service === "paycom" && item.reason === "security_answers_rejected")
    return "Paycom rejected the security-answer step. Contact your Dispatch administrator to verify the saved numbered PINs and complete sign-in.";
  if (item.state === "verification_required")
    return "The service needs human verification. Contact your Dispatch administrator to complete it, then test the connection again.";
  if (item.state === "credentials_rejected")
    return "The service rejected the saved login. Check your account details and update the credentials.";
  if (item.state === "temporarily_unavailable")
    return "We couldn’t verify this connection. Your credentials remain saved. Try testing it again shortly.";
  if (item.state === "checking")
    return "Verifying your login. You can leave this page while the check finishes.";
  if (item.state === "not_verified")
    return "Credentials are saved. Test the connection to verify access.";
  if (item.state === "connected")
    return "Signed in successfully. Your DSP’s connection is saved securely.";
  return "Connect once to make this service available to your DSP’s features.";
}

function VerificationPrompt({
  verification,
  busy,
  onVerify,
}: {
  verification: NonNullable<Connection["verification"]>;
  busy: boolean;
  onVerify: (values: Record<string, FormDataEntryValue>) => Promise<void>;
}) {
  const { timeZone } = useTimezone();
  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = {
      code: String(new FormData(form).get("code") || "").trim(),
      verificationId: verification.id,
    };
    form.reset();
    try {
      await onVerify(values);
    } finally {
      values.code = "";
    }
  }
  return (
    <form
      onSubmit={submitCode}
      className="flex flex-col gap-3"
      aria-label="Cortex email verification"
    >
      <TextField
        label="Email verification code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        minLength={6}
        maxLength={6}
        required
        disabled={busy}
      />
      <p className="text-xs text-muted-foreground">
        Enter the six-digit code. This prompt expires at{" "}
        {dateTime(verification.expiresAt, timeZone)}.
      </p>
      <SubmitButton
        busy={busy}
        disabled={busy || verification.attemptsRemaining === 0}
      >
        Verify code
      </SubmitButton>
    </form>
  );
}

export function Connections() {
  const { timeZone } = useTimezone();
  const { session } = useSession();
  const membership = activeMembership(session);
  const owner = isDspOwner(session);
  const query = useQuery({
    queryKey: ["connections", membership?.organizationId],
    queryFn: ({ signal }) =>
      request<ConnectionsData>("/api/organization/connections", { signal }),
    enabled: owner,
    refetchInterval: (q) =>
      q.state.data?.items.some(
        (item) =>
          item.state === "checking" ||
          item.state === "not_verified" ||
          !!item.verification,
      )
        ? 2000
        : 15000,
  });
  const [selected, setSelected] = useState<{
    service: Service;
    action: "save" | "disconnect";
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testedService, setTestedService] = useState<string | null>(null);
  const [saveUnconfirmed, setSaveUnconfirmed] = useState(false);
  const testedConnection = query.data?.items.find(
    (item) => item.service === testedService,
  );
  const testNotice =
    testedService && testedConnection
      ? `${query.data?.services.find((service) => service.id === testedService)?.name}: ${busy === testedService ? "Checking session" : connectionLabel(testedConnection)}.`
      : null;
  if (!owner) return null;
  async function perform(
    service: Service,
    action: "save" | "test" | "disconnect" | "verify",
    values?: Record<string, FormDataEntryValue>,
  ) {
    setBusy(service.id);
    setError(null);
    setNotice(null);
    setTestedService(action === "test" ? service.id : null);
    setSaveUnconfirmed(false);
    try {
      const result = await mutation<Connection>(
        `/api/organization/connections/${service.id}/${action}`,
        "POST",
        action === "save"
          ? { credentials: values }
          : action === "verify"
            ? values
            : {},
      );
      if (action === "test" || action === "save") {
        queryClient.setQueryData<ConnectionsData>(
          ["connections", membership?.organizationId],
          (previous) =>
            previous
              ? {
                  ...previous,
                  items: previous.items.map((item) =>
                    item.service === service.id ? result : item,
                  ),
                }
              : previous,
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ["paycom-connection", membership?.organizationId],
      });
      setSelected(null);
      setNotice(
        action === "verify"
          ? null
          : action === "disconnect"
            ? `${service.name} disconnected.`
            : action === "save"
              ? `${service.name} credentials saved.`
              : null,
      );
      await query.refetch();
    } catch (caught) {
      setError(caught);
      setTestedService(null);
      if (
        action === "save" &&
        (!(caught instanceof ApiError) ||
          !caught.status ||
          caught.status >= 500)
      ) {
        setSaveUnconfirmed(true);
        // Reconcile in the background so a slow status check cannot trap the
        // owner in a disabled credential dialog after the save already failed.
        void query.refetch().catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const credentials = Object.fromEntries(new FormData(form));
    // Clear password fields immediately; never put credentials in query/cache state.
    form.reset();
    await perform(selected.service, "save", credentials);
    for (const key of Object.keys(credentials)) credentials[key] = "";
  }
  return (
    <section
      className="flex flex-col gap-6 py-6"
      aria-labelledby="connections-heading"
    >
      <div>
        <h2 id="connections-heading" className="text-lg font-semibold">
          Connections
        </h2>
        <p className="text-muted-foreground">
          Connect the services your DSP uses. All supported features share these
          connections.
        </p>
      </div>
      {!selected && <ErrorNotice error={error || query.error} />}
      {notice && <Notice>{notice}</Notice>}
      {testNotice && (
        <div role="status">
          <Notice
            error={
              !!testedConnection &&
              !["checking", "connected"].includes(testedConnection.state)
            }
          >
            {testNotice}
          </Notice>
        </div>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.data ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {query.data.services.map((service) => {
            const item = query.data.items.find(
              (item) => item.service === service.id,
            );
            if (!item) return null;
            const checking = item.state === "checking";
            const disabled = busy !== null || checking;
            return (
              <Card key={service.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-3">
                    <Plug className="size-5" aria-hidden="true" />
                    {service.name}
                  </CardTitle>
                  <CardDescription>
                    {service.id === "cortex"
                      ? "Amazon Logistics dashboard"
                      : "Workforce and timecards"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div role="status">
                    <Badge
                      variant={
                        item.state === "connected" ? "default" : "secondary"
                      }
                    >
                      {connectionLabel(item)}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {guidance(item)}
                  </p>
                  {item.verification && (
                    <VerificationPrompt
                      key={item.verification.id}
                      verification={item.verification}
                      busy={disabled}
                      onVerify={(values) => perform(service, "verify", values)}
                    />
                  )}
                  {item.checkedAt && (
                    <p className="text-xs text-muted-foreground">
                      Last checked: {dateTime(item.checkedAt, timeZone)}
                    </p>
                  )}
                  {item.retryAt && (
                    <p className="text-sm">
                      Retry after {dateTime(item.retryAt, timeZone)}
                    </p>
                  )}
                </CardContent>
                <CardFooter className="mt-auto flex flex-wrap gap-2">
                  <Button
                    disabled={disabled}
                    onClick={() => {
                      setError(null);
                      setSaveUnconfirmed(false);
                      setSelected({ service, action: "save" });
                    }}
                  >
                    {item.configured
                      ? "Update credentials"
                      : `Connect ${service.name}`}
                  </Button>
                  {item.configured && (
                    <>
                      <Button
                        variant="outline"
                        disabled={
                          disabled ||
                          !!item.verification ||
                          (service.id !== "paycom" &&
                            !!item.retryAt &&
                            Date.parse(item.retryAt) > Date.now())
                        }
                        onClick={() => void perform(service, "test")}
                      >
                        <RefreshCw className="size-4" aria-hidden="true" />
                        Test connection
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => {
                          setError(null);
                          setSelected({ service, action: "disconnect" });
                        }}
                      >
                        Disconnect
                      </Button>
                    </>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : (
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry loading connections
        </Button>
      )}
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
        DSP owners and platform owners can manage these credentials.
      </p>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setSelected(null);
            setError(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selected?.action === "disconnect"
                ? `Disconnect ${selected.service.name}?`
                : `${selected?.service.name || "Service"} credentials`}
            </DialogTitle>
            <DialogDescription>
              {selected?.action === "disconnect"
                ? "Features will lose access to this service until you reconnect. Previously collected data will remain available."
                : "Enter the account your DSP uses. Saved credentials are encrypted and are never displayed here."}
            </DialogDescription>
          </DialogHeader>
          {selected?.action === "save" ? (
            <form key={selected.service.id} onSubmit={submit}>
              <FieldGroup>
                {selected.service.fields.map((field) => (
                  <TextField
                    key={field.name}
                    name={field.name}
                    label={field.label}
                    type={
                      field.name === "password" || field.name.startsWith("pin")
                        ? "password"
                        : "text"
                    }
                    autoComplete={
                      field.name === "username" ? "username" : "off"
                    }
                    maxLength={field.maximum}
                    required
                    disabled={busy !== null}
                  />
                ))}
                {selected.service.id === "paycom" && (
                  <p className="text-sm text-muted-foreground">
                    Enter all five distinct security answers in the order
                    configured for your Paycom account.
                  </p>
                )}
                <ErrorNotice error={error} />
                {saveUnconfirmed && (
                  <Notice>
                    We couldn’t confirm this save. Your credentials may already
                    be stored. Close this form to check the connection before
                    retrying.
                  </Notice>
                )}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => setSelected(null)}
                  >
                    Cancel
                  </Button>
                  <SubmitButton
                    busy={busy !== null}
                    disabled={busy !== null || saveUnconfirmed}
                  >
                    Save and connect
                  </SubmitButton>
                </DialogFooter>
              </FieldGroup>
            </form>
          ) : (
            <>
              <ErrorNotice error={error} />
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setSelected(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy !== null}
                  onClick={() =>
                    selected && void perform(selected.service, "disconnect")
                  }
                >
                  Disconnect
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
