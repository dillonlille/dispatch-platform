import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { mutation, request } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useTimezone } from "@/lib/timezone";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

type Change = {
  kind: "added" | "improved" | "changed" | "fixed" | "removed";
  title: string;
  description: string;
};
type Release = {
  releaseId: string;
  version: string;
  publishedAt: string;
  changelog: Change[];
  afterUpdating: { title: string; description: string }[];
};
const sections = [
  { title: "New", kinds: ["added"] },
  { title: "Improved", kinds: ["improved", "changed"] },
  { title: "Fixed", kinds: ["fixed"] },
  { title: "Removed", kinds: ["removed"] },
];

export function ReleasePopup() {
  const { session } = useSession();
  const { timeZone } = useTimezone();
  const [release, setRelease] = useState<Release | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let cancelled = false;
    // Check on entry, not on every navigation or while the user is working.
    void request<{ release: Release | null }>("/api/updates/popup")
      .then((data) => {
        if (!cancelled) setRelease(data.release);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  async function dismiss() {
    if (!release || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(false);
    try {
      await mutation("/api/updates/popup", "POST", {
        releaseId: release.releaseId,
      });
      setRelease(null);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  // Another open tab can acknowledge the release without interrupting this tab.
  useEffect(() => {
    if (!release) return;
    const check = () => {
      void request<{ release: Release | null }>("/api/updates/popup")
        .then((data) => {
          if (!data.release) setRelease(null);
        })
        .catch(() => {});
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [release]);
  if (!release || session.dspView) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void dismiss();
      }}
    >
      <DialogContent
        className="release-popup"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        <header className="release-popup-header">
          <p className="release-popup-eyebrow">What’s new</p>
          <DialogTitle
            ref={heading}
            tabIndex={-1}
            className="release-popup-title"
          >
            Dispatch {release.version}
          </DialogTitle>
          <DialogDescription>
            <time dateTime={release.publishedAt}>
              {new Date(release.publishedAt).toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
                timeZone,
              })}
            </time>
            <span className="release-popup-intro">
              Here’s what changed in the latest release.
            </span>
          </DialogDescription>
          <Button
            variant="ghost"
            size="icon"
            className="release-popup-close"
            aria-label="Close update"
            disabled={saving}
            onClick={() => void dismiss()}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="release-popup-body">
          {sections.map((section) => {
            const items = release.changelog.filter((item) =>
              section.kinds.includes(item.kind),
            );
            if (!items.length) return null;
            return (
              <section key={section.title} aria-label={section.title}>
                <h3>{section.title}</h3>
                <ul>
                  {items.map((item, index) => (
                    <li key={index}>
                      <strong>{item.title}</strong>
                      {item.description && <p>{item.description}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {release.afterUpdating.length > 0 && (
            <section aria-label="After updating">
              <h3>After updating</h3>
              <ul>
                {release.afterUpdating.map((item, index) => (
                  <li key={index}>
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <footer className="release-popup-footer">
          {error && (
            <p role="alert">
              We couldn’t save your dismissal. Please try again.
            </p>
          )}
          <Button disabled={saving} onClick={() => void dismiss()}>
            {saving ? "Saving…" : error ? "Try again" : "Got it"}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
