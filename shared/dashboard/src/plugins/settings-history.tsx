import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api.ts";
import { dateTime } from "../lib/date-time.ts";
import { useTimezone } from "../lib/timezone.tsx";
import { Button } from "../components/ui/button.tsx";
import { ErrorNotice, Loading } from "../components/shared.tsx";
import type {
  Input,
  SettingsHistory,
  SettingsSnapshot,
  SettingsSources,
} from "dispatch-sdk";
import { formatSettingValue } from "dispatch-sdk/settings-behavior";

export function PluginSettingsHistory({
  pluginId,
  scope,
  snapshot,
  busy,
  onRestore,
}: {
  pluginId: string;
  scope: string;
  snapshot: SettingsSnapshot;
  busy: boolean;
  onRestore(values: Input, sources: SettingsSources, fields: string[]): void;
}) {
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const before = cursors[cursors.length - 1];
  const { timeZone } = useTimezone();
  const history = useQuery({
    queryKey: [
      "plugin-settings",
      pluginId,
      scope,
      "history",
      snapshot.revision,
      before,
    ],
    queryFn: ({ signal }) =>
      request<SettingsHistory>(
        `/api/organization/plugins/${encodeURIComponent(pluginId)}/settings/history${before === null ? "" : `?before=${before}`}`,
        { signal },
      ),
  });
  return (
    <section
      className="plugin-settings-history"
      aria-label="Settings change history"
    >
      <h2>Change history</h2>
      <p>
        Restore values into your draft, then review and save. History belongs to
        this DSP.
      </p>
      <ErrorNotice error={history.error} />
      {history.isPending && <Loading />}
      {history.data?.items.map((item) => (
        <details key={item.revision} data-revision={item.revision}>
          <summary>
            {dateTime(item.updatedAt, timeZone)} ·{" "}
            {item.kind === "initial"
              ? "Initial settings"
              : item.actorName || "Plugin update"}{" "}
            · Revision {item.revision}
          </summary>
          {item.changes.length ? (
            <ul>
              {item.changes.map((change) => {
                const field = snapshot.definition.fields.find(
                  (field) => field.id === change.field,
                );
                const format = (value: typeof change.before) =>
                  field
                    ? formatSettingValue(field, value)
                    : JSON.stringify(value);
                return (
                  <li key={change.field}>
                    <strong>{change.label}</strong>: {format(change.before)} →{" "}
                    {format(change.after)}
                    {change.beforeSource !== change.afterSource && (
                      <span>
                        {" "}
                        (
                        {change.afterSource === "default"
                          ? "Plugin default"
                          : "DSP override"}
                        )
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No values changed.</p>
          )}
          {item.canRestore ? (
            <div className="plugin-settings-history-actions">
              {snapshot.definition.sections.map((section) => (
                <Button
                  key={section.id}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onRestore(
                      item.values,
                      item.sources,
                      snapshot.definition.fields
                        .filter((field) => field.section === section.id)
                        .map((field) => field.id),
                    )
                  }
                >
                  Restore {section.label}
                </Button>
              ))}
              <details>
                <summary>Restore an individual setting</summary>
                {snapshot.definition.fields.map((field) => (
                  <Button
                    key={field.id}
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      onRestore(item.values, item.sources, [field.id])
                    }
                  >
                    Restore {field.label}
                  </Button>
                ))}
              </details>
            </div>
          ) : (
            <p>
              This entry predates the current settings definition and cannot be
              restored directly.
            </p>
          )}
        </details>
      ))}
      <div className="plugin-settings-history-pagination">
        <Button
          variant="outline"
          disabled={cursors.length === 1 || history.isFetching}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          Newer changes
        </Button>
        <Button
          variant="outline"
          disabled={history.data?.nextBefore == null || history.isFetching}
          onClick={() =>
            setCursors((current) => [...current, history.data!.nextBefore])
          }
        >
          Older changes
        </Button>
      </div>
    </section>
  );
}
