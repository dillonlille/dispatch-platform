import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import type { Session } from "@/lib/types";
import { Brand } from "@/components/Brand";
import { Turnstile } from "@/components/Turnstile";
import { FieldGroup } from "@/components/ui/field";
import {
  ErrorNotice,
  Notice,
  SubmitButton,
  TextField,
} from "@/components/shared";

export function PasswordRecovery({
  hash,
  session,
  refresh,
}: {
  hash: string;
  session: Session | null;
  refresh: () => Promise<void>;
}) {
  const requesting = hash === "#/forgot-password";
  const [token, setToken] = useState(
    () => /^#\/reset-password\/([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const [verification, setVerification] = useState("");
  const [attempt, setAttempt] = useState(0);
  const siteKey = requesting ? session?.turnstile?.siteKey : null;
  useEffect(() => {
    if (!requesting) {
      // Keep the bearer secret in this mounted form only, never browser storage,
      // query caches or history. Reloading requires reopening the email link.
      history.replaceState(null, "", `${location.pathname}#/reset-password`);
    }
  }, [requesting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (siteKey && !verification)) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError(null);
    try {
      // Recovery is independent of any existing signed-in account or DSP view.
      const response = await fetch(
        requesting ? "/api/auth/forgot-password" : "/api/auth/reset-password",
        {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            ...Object.fromEntries(form),
            ...(requesting
              ? siteKey
                ? { turnstileToken: verification }
                : {}
              : { token }),
          }),
        },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok)
        throw new ApiError(
          result?.error?.code || "request_failed",
          response.status,
        );
      formElement.reset();
      setMessage(result.data.message);
      if (!requesting) {
        setToken("");
        // The server has revoked sessions for the recovered account. Refresh
        // local state without converting a completed reset into a UI failure.
        void refresh().catch(() => {});
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
      setVerification("");
      setAttempt((value) => value + 1);
    }
  }

  return (
    <main className="auth-layout">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-panel">
        <h1>
          {message
            ? requesting
              ? "Check your email"
              : "Password reset"
            : requesting
              ? "Forgot your password?"
              : "Set a new password"}
        </h1>
        <p className="auth-description">
          {requesting
            ? "Enter your Dispatch account email and we’ll send you a reset link."
            : "Choose a password you haven’t used elsewhere."}
        </p>
        <ErrorNotice error={error} />
        {message ? (
          <Notice>{message}</Notice>
        ) : !requesting && !token ? (
          <Notice>
            This reset link is invalid or has expired. Request a new link to
            continue.
          </Notice>
        ) : (
          <form onSubmit={submit}>
            <FieldGroup>
              {requesting ? (
                <TextField
                  label="Email address"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  disabled={busy}
                />
              ) : (
                <>
                  <TextField
                    label="New password"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    disabled={busy}
                    description="Use 12–128 characters."
                  />
                  <TextField
                    label="Confirm new password"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    disabled={busy}
                  />
                </>
              )}
              {siteKey && (
                <Turnstile
                  key={attempt}
                  siteKey={siteKey}
                  action="forgot_password"
                  onToken={setVerification}
                  busy={busy}
                />
              )}
              <SubmitButton
                busy={busy}
                disabled={busy || Boolean(siteKey && !verification)}
              >
                {requesting ? "Send reset link" : "Reset password"}
              </SubmitButton>
            </FieldGroup>
          </form>
        )}
        <div className="mt-6 flex flex-wrap gap-4 text-sm text-primary">
          <a className="underline-offset-4 hover:underline" href="#/login">
            Back to sign in
          </a>
          {!requesting && (
            <a
              className="underline-offset-4 hover:underline"
              href="#/forgot-password"
            >
              Request a new link
            </a>
          )}
        </div>
      </section>
      <p className="auth-footnote">
        {requesting
          ? "Reset links expire after 30 minutes."
          : "Resetting your password signs out your existing sessions."}
      </p>
    </main>
  );
}
