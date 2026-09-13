import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import {
  activeMembership,
  has,
  isPlatform,
  isDspOwner,
  mutation,
  request,
} from "@/lib/api";
import type { Profile, Session } from "@/lib/types";
import {
  PageHeading,
  TextField,
  ErrorNotice,
  Notice,
  SubmitButton,
  Loading,
} from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Brand } from "@/components/Brand";
import { Connections } from "@/pages/Connections";
import { AuditLog } from "@/components/AuditLog";
import { ThemeSection } from "@/components/ThemeSection";
import { TimezoneSection } from "@/components/TimezoneSection";
import { deviceTimeZone } from "@/lib/date-time";
import { FieldGroup } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
export function DspProfile({ onboarding = false }: { onboarding?: boolean }) {
  const { session, refresh } = useSession();
  const membership = onboarding
    ? session.memberships.find(
        (m) => m.organizationId === session.activeOrganizationId,
      ) || null
    : activeMembership(session);
  const profile = useQuery({
    queryKey: ["profile", membership?.organizationId],
    queryFn: () => request<Profile>("/api/organization/profile"),
    enabled:
      has(membership, "organization.owner") &&
      membership?.organization.status !== "suspended",
    refetchInterval: (q) =>
      q.state.data?.status === "submitted" ? 2000 : false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!has(membership, "organization.owner")) return null;
  if (profile.error) return <ErrorNotice error={profile.error} />;
  if (!profile.data) return onboarding ? <Loading /> : null;
  if (
    profile.data.status === "complete" ||
    profile.data.status === "submitted"
  ) {
    if (!onboarding && profile.data.status === "complete") return null;
    return (
      <>
        <Notice>
          {profile.data.status === "complete"
            ? "Your DSP details are complete. You can continue to your workspace."
            : "Your DSP details are saved. They’ll be applied when your workspace is ready."}
        </Notice>
        {onboarding && (
          <Button
            className="mt-6"
            onClick={() => {
              location.hash = isPlatform(session) ? "#/platform" : "#/settings";
            }}
          >
            Continue to workspace
          </Button>
        )}
      </>
    );
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError(null);
    try {
      await mutation("/api/organization/profile", "POST", body);
      await profile.refetch();
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={onboarding ? "onboarding-details" : "setup-section"}>
      {!onboarding && (
        <div>
          <h2>Set up your DSP</h2>
          <p>
            Your workspace is being prepared. Add your DSP details to finish
            onboarding.
          </p>
        </div>
      )}
      <form onSubmit={submit}>
        <FieldGroup>
          <TextField
            label="DSP name"
            name="name"
            minLength={2}
            maxLength={120}
            required
            disabled={busy}
          />
          <TextField
            label="Abbreviation (optional)"
            name="abbreviation"
            maxLength={16}
            disabled={busy}
          />
          <TextField
            label="Station code"
            name="stationCode"
            pattern="[A-Za-z0-9]{3,8}"
            maxLength={8}
            required
            disabled={busy}
          />
          <TextField
            label="Business timezone"
            name="timezone"
            defaultValue={
              deviceTimeZone()
            }
            maxLength={64}
            required
            disabled={busy}
          />
          <ErrorNotice error={error} />
          <SubmitButton busy={busy} disabled={busy}>
            Save DSP details
          </SubmitButton>
        </FieldGroup>
      </form>
    </section>
  );
}
export function Settings() {
  const { session, refresh } = useSession();
  const readTab = () => {
    const value = new URLSearchParams(location.hash.split("?")[1]).get("tab");
    return value === "theme" ||
      value === "security" ||
      value === "audit" ||
      value === "connections"
      ? value
      : "general";
  };
  const [tab, setTab] = useState(readTab);
  useEffect(() => {
    const update = () => setTab(readTab());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const platform = isPlatform(session);
  const membership = activeMembership(session);
  const canManageConnections = isDspOwner(session);
  const canReadAudit = !platform && has(membership, "audit.read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await mutation<Session>("/api/auth/change-password", "POST", body);
      await refresh();
      form.reset();
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Settings"
        description={
          platform
            ? "Your platform account and security."
            : "Your account, workspace, and security."
        }
      />
      <Tabs
        value={
          (tab === "audit" && !canReadAudit) ||
          (tab === "connections" && !canManageConnections)
            ? "general"
            : tab
        }
        onValueChange={(value) => {
          setTab(value);
          history.replaceState(
            {},
            "",
            `${location.pathname}${location.search}${location.hash.split("?")[0]}?tab=${value}`,
          );
        }}
      >
        <TabsList variant="line" className="page-tabs">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          {canManageConnections && (
            <TabsTrigger value="connections">Connections</TabsTrigger>
          )}
          <TabsTrigger value="theme">Theme</TabsTrigger>
          {canReadAudit && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>
        {canManageConnections && (
          <TabsContent value="connections">
            <Connections key={membership?.organizationId} />
          </TabsContent>
        )}
        <TabsContent value="general">
          <section className="settings-section">
            <div>
              <h2>Account</h2>
              <p>
                {session.dspView
                  ? "You are signed in with your platform account."
                  : "Your Dispatch sign-in details."}
              </p>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Name</dt>
                <dd>{session.user.name}</dd>
              </div>
              <div>
                <dt>Email address</dt>
                <dd>{session.user.email}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>
                  {platform || session.dspView
                    ? "Platform owner"
                    : membership?.roleName || "No DSP access"}
                </dd>
              </div>
            </dl>
          </section>
          <TimezoneSection />
          {!platform && (
            <>
              <section className="settings-section">
                <div>
                  <h2>Workspace</h2>
                  <p>Your current DSP context.</p>
                </div>
                <dl className="detail-list">
                  <div>
                    <dt>DSP</dt>
                    <dd>
                      {membership?.organization.name || "No DSP selected"}
                    </dd>
                  </div>
                  <div>
                    <dt>Station</dt>
                    <dd>
                      {membership?.organization.stations
                        .map((s) => s.code)
                        .join(", ") || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Business timezone</dt>
                    <dd>{membership?.organization.timezone || "—"}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      {membership?.organization.status.replaceAll("_", " ") ||
                        "Unavailable"}
                    </dd>
                  </div>
                </dl>
              </section>
              <DspProfile />
            </>
          )}
        </TabsContent>
        {canReadAudit && (
          <TabsContent value="audit">
            <AuditLog />
          </TabsContent>
        )}
        <TabsContent value="theme">
          <ThemeSection />
        </TabsContent>
        <TabsContent value="security">
          <section className="settings-section">
            <div>
              <h2>Change password</h2>
              <p>Changing your password signs out every other session.</p>
            </div>
            <form onSubmit={changePassword} className="max-w-md">
              <FieldGroup>
                <TextField
                  label="Current password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                  disabled={busy}
                />
                <TextField
                  label="New password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy}
                  description="Use at least 12 characters."
                />
                <TextField
                  label="Confirm new password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy}
                />
                <ErrorNotice error={error} />
                {saved && (
                  <Notice>
                    Password changed. Other sessions have been signed out.
                  </Notice>
                )}
                <div>
                  <SubmitButton busy={busy} disabled={busy}>
                    Change password
                  </SubmitButton>
                </div>
              </FieldGroup>
            </form>
          </section>
        </TabsContent>
      </Tabs>
    </>
  );
}

export function DspOnboarding() {
  useEffect(() => {
    document.title = "Set up your DSP · Dispatch";
  }, []);
  return (
    <main className="auth-layout">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-panel">
        <p className="text-sm text-muted-foreground mb-3">
          Step 2 of 2 · DSP details
        </p>
        <h1>Set up your DSP</h1>
        <p className="auth-description">
          Your account is ready. Add your DSP details while we prepare your
          workspace.
        </p>
        <DspProfile onboarding />
      </section>
    </main>
  );
}
