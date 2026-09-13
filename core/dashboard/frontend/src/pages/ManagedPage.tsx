import { useEffect, useMemo, useState } from "react";
import { mutation, mutationKey, request, settleMutationKey } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { dspIdentity } from "@/lib/identity";
import { useTimezone } from "@/lib/timezone";
import { PageHeading, RefreshButton, Notice } from "@/components/shared";
const byId = (id: string) => document.getElementById(id);
const node = (tag: string, className?: string | null, text?: unknown) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};
const dependencies = {
  timeZone: undefined as string | undefined,
  dspIdentity,
  byId,
  node,
  mutation,
  request,
  mutationKey,
  settleMutationKey,
  errorMessage,
};
declare global {
  interface Window {
    createUpdatesViews: (deps: typeof dependencies) => {
      renderUpdates: () => Promise<void>;
      setUpdatesActive: (active: boolean) => void;
    };
    createBackupsViews: (deps: typeof dependencies) => {
      renderBackups: () => Promise<void>;
      setBackupsActive: (active: boolean) => void;
    };
    showToast?: (title: string, detail?: string, type?: string) => void;
  }
}
// The controllers own only these empty DOM islands. React owns the shell and
// their lifetime; the existing polling and recovery state machines stay intact.
export function ManagedPage({
  page,
  hash,
}: {
  page: "updates" | "backups";
  hash: string;
}) {
  const { timeZone } = useTimezone();
  const controller = useMemo(
    () =>
      page === "updates"
        ? window.createUpdatesViews({ ...dependencies, timeZone })
        : window.createBackupsViews({ ...dependencies, timeZone }),
    [page, timeZone],
  );
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const render = () =>
    "renderUpdates" in controller
      ? controller.renderUpdates()
      : controller.renderBackups();
  useEffect(() => {
    window.showToast = (title, detail, type) =>
      setNotice({
        text: [title, detail].filter(Boolean).join(". "),
        error: type === "error",
      });
    if ("setUpdatesActive" in controller) controller.setUpdatesActive(true);
    else controller.setBackupsActive(true);
    void render();
    return () => {
      if ("setUpdatesActive" in controller) controller.setUpdatesActive(false);
      else controller.setBackupsActive(false);
      delete window.showToast;
    };
  }, [controller, hash]);
  return (
    <>
      {page === "updates" && (
        <PageHeading
          title="Updates"
          description="Explore what’s new in Dispatch."
        >
          <RefreshButton onClick={() => void render()} />
        </PageHeading>
      )}
      {notice && <Notice error={notice.error}>{notice.text}</Notice>}
      <div
        id={
          page === "updates"
            ? "platform-updates-content"
            : "platform-backups-content"
        }
        className={
          page === "updates" ? "updates-workspace" : "backup-workspace"
        }
      />
    </>
  );
}
