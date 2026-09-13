import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      size: "flexible";
      "response-field": false;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      "timeout-callback": () => void;
      "unsupported-callback": () => void;
    },
  ) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const fail = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      script.remove();
      reject(new Error("turnstile_unavailable"));
    };
    const timer = window.setTimeout(fail, 15000);
    script.onerror = fail;
    script.onload = () => {
      if (!window.turnstile) return fail();
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      resolve(window.turnstile);
    };
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

export function Turnstile({
  siteKey,
  action,
  onToken,
  busy,
}: {
  siteKey: string;
  action: "login" | "register" | "forgot_password";
  onToken: (token: string) => void;
  busy: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<
    "checking" | "ready" | "expired" | "error"
  >("checking");
  useEffect(() => {
    let disposed = false;
    let api: TurnstileApi | undefined;
    let widget: string | undefined;
    onToken("");
    setStatus("checking");
    const invalidate = (next: "expired" | "error") => {
      if (disposed) return;
      onToken("");
      setStatus(next);
    };
    void loadTurnstile()
      .then((loaded) => {
        if (disposed || !container.current) return;
        api = loaded;
        widget = api.render(container.current, {
          sitekey: siteKey,
          action,
          size: "flexible",
          "response-field": false,
          callback: (token) => {
            if (disposed) return;
            onToken(token);
            setStatus("ready");
          },
          "error-callback": () => invalidate("error"),
          "expired-callback": () => invalidate("expired"),
          "timeout-callback": () => invalidate("expired"),
          "unsupported-callback": () => invalidate("error"),
        });
      })
      .catch(() => invalidate("error"));
    return () => {
      disposed = true;
      if (widget !== undefined) api?.remove(widget);
    };
  }, [siteKey, action, attempt, onToken]);
  return (
    <div className="min-w-0 space-y-2" aria-label="Security verification">
      <div ref={container} />
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {status === "checking"
          ? "Checking your browser…"
          : status === "ready"
            ? "Security check complete."
            : status === "expired"
              ? "Security check expired. Please verify again."
              : "Security check could not load. Check your connection and try again."}
      </p>
      {(status === "error" || status === "expired") && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry security check
        </Button>
      )}
    </div>
  );
}
