import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { mutation } from "@/lib/api";
import type { Session, InvitationInfo } from "@/lib/types";
import { FieldGroup } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import {
  TextField,
  ErrorNotice,
  Notice,
  SubmitButton,
  Loading,
} from "@/components/shared";
import { Turnstile } from "@/components/Turnstile";
import { Brand } from "@/components/Brand";
export function Auth({
  session,
  refresh,
  token,
}: {
  session: Session | null;
  refresh: () => Promise<void>;
  token: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const invite = useQuery({
    queryKey: ["invitation", token],
    enabled: Boolean(token) && !busy,
    queryFn: () =>
      mutation<InvitationInfo>("/api/auth/invitation/inspect", "POST", {
        token,
      }),
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    setError(null);
  }, [token]);
  const info = invite.data;
  const invitation = Boolean(token);
  const registering = invitation && !info?.accountExists;
  const action = registering ? "register" : "login";
  const siteKey = session?.turnstile?.siteKey;
  const scope = `${siteKey}:${action}:${token || ""}`;
  const [verification, setVerification] = useState({ scope: "", token: "" });
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const verificationToken =
    verification.scope === scope ? verification.token : "";
  const onVerification = useCallback(
    (value: string) => {
      setVerification({ scope, token: value });
    },
    [scope],
  );
  const dspOwner = info?.kind === "organization_owner";
  async function finishInvitation() {
    await refresh();
    history.replaceState(
      {},
      "",
      `${location.pathname}${location.search}${dspOwner ? "#/onboarding" : "#/team"}`,
    );
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (siteKey && !verificationToken) {
      setError("turnstile_required");
      return;
    }
    const form = new FormData(event.currentTarget);
    const security = siteKey ? { turnstileToken: verificationToken } : {};
    setBusy(true);
    setError(null);
    try {
      if (registering) {
        await mutation("/api/auth/register", "POST", {
          token,
          ...Object.fromEntries(form),
          ...security,
        });
        await finishInvitation();
      } else {
        await mutation("/api/auth/login", "POST", {
          ...Object.fromEntries(form),
          ...security,
        });
        await refresh();
        if (invitation) {
          await mutation("/api/auth/accept-invitation", "POST", { token });
          await finishInvitation();
        }
      }
    } catch (e) {
      setError(e);
      // A token is single-use even when password or invitation validation fails.
      onVerification("");
      setVerificationAttempt((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await mutation("/api/auth/accept-invitation", "POST", { token });
      await finishInvitation();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-panel">
        {invitation && dspOwner && (
          <p className="text-sm text-muted-foreground mb-3">
            Step 1 of 2 · Your account
          </p>
        )}
        <h1>
          {invitation && dspOwner
            ? "Create your DSP"
            : invitation
              ? info?.kind === "platform_owner"
                ? "Join Dispatch"
                : `Join ${info?.organization?.name || "Dispatch"}`
              : "Sign in to Dispatch"}
        </h1>
        <p className="auth-description">
          {invitation
            ? info
              ? `${info.email} · ${info.role?.name || "Platform owner"}`
              : "Checking your invitation…"
            : "Welcome back. Sign in to your workspace."}
        </p>
        {invitation && info && (
          <p className="auth-description">
            {info.accountExists
              ? "You already have a Dispatch account. Use it to continue" +
                (dspOwner
                  ? " setting up your new DSP."
                  : " with this invitation.")
              : dspOwner
                ? "Create your account, then add your DSP details to finish setup."
                : "Create your account to accept this invitation."}
          </p>
        )}
        <ErrorNotice error={error || invite.error} />
        {session?.bootstrap?.initialized === false && (
          <Notice>
            Platform setup required. Create the platform owner using the private
            access administration command.
          </Notice>
        )}
        {invitation && invite.isPending ? (
          <Loading />
        ) : invitation && !info ? null : invitation &&
          info?.accountExists &&
          session?.authenticated ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Signed in as {session.user.email}.
            </p>
            <Button disabled={busy} onClick={accept}>
              {dspOwner ? "Continue to DSP setup" : "Accept invitation"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await mutation("/api/auth/logout", "POST", {});
                  await refresh();
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Use another account
            </Button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup>
              {registering ? (
                <>
                  <TextField
                    label="First name"
                    name="firstName"
                    autoComplete="given-name"
                    required
                    maxLength={80}
                    disabled={busy}
                  />
                  <TextField
                    label="Last name"
                    name="lastName"
                    autoComplete="family-name"
                    required
                    maxLength={80}
                    disabled={busy}
                  />
                </>
              ) : (
                <TextField
                  label="Email address"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  disabled={busy}
                />
              )}
              <TextField
                label="Password"
                name="password"
                type="password"
                autoComplete={registering ? "new-password" : "current-password"}
                minLength={registering ? 12 : undefined}
                maxLength={128}
                required
                disabled={busy}
                description={
                  registering ? "Use at least 12 characters." : undefined
                }
              />
              {!registering && (
                <a
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  href="#/forgot-password"
                >
                  Forgot password?
                </a>
              )}
              {registering && (
                <TextField
                  label="Confirm password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  disabled={busy}
                />
              )}
              {siteKey && (
                <Turnstile
                  key={`${scope}:${verificationAttempt}`}
                  siteKey={siteKey}
                  action={action}
                  onToken={onVerification}
                  busy={busy}
                />
              )}
              <SubmitButton
                busy={busy}
                disabled={busy || Boolean(siteKey && !verificationToken)}
              >
                {registering
                  ? dspOwner
                    ? "Create account and continue"
                    : "Create account and accept"
                  : invitation
                    ? "Sign in and continue"
                    : "Sign in"}
              </SubmitButton>
            </FieldGroup>
          </form>
        )}
      </section>
      <p className="auth-footnote">Access is by invitation.</p>
    </main>
  );
}
