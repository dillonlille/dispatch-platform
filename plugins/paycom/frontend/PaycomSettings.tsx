import { usePaycomSync } from "./usePaycomSync.ts";
import {
  Button,
  ErrorNotice,
  PluginSettingsForm,
  activeMembership,
  dateTime,
  useSession,
  useTimezone,
} from "dispatch-sdk/ui";

export type PaycomPreferences = {
  automatic_sync: boolean;
  sync_interval_seconds: number;
  opening_page: "timecards" | "employees";
  rows_per_page: number;
  name_order: "last_first" | "first_last";
  default_sort: "employeeName" | "condition" | "inDay";
  department: string | null;
  station: string | null;
  columns: string[];
  driver_departments: string[] | null;
};
function ScheduleStatus() {
  const { timeZone } = useTimezone();
  const { session } = useSession(),
    scope = `${activeMembership(session)?.organizationId}:${session.dspView?.viewRef || "member"}`;
  const { query: status, run, message } = usePaycomSync(scope);
  return (
    <div className="paycom-settings-status">
      <ErrorNotice error={status.error || run.error} />
      <p>
        Last successful sync{" "}
        <strong>
          {status.data?.lastSucceededAt
            ? dateTime(status.data.lastSucceededAt, timeZone)
            : "Not yet synced"}
        </strong>
      </p>
      <p>
        Next scheduled sync{" "}
        <strong>
          {status.data?.nextDueAt
            ? dateTime(status.data.nextDueAt, timeZone)
            : "Not scheduled"}
        </strong>
      </p>
      <div>
        <Button variant="outline" onClick={() => run.mutate()}>
          Sync now
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            location.hash = "#/settings?tab=connections";
          }}
        >
          Manage connection ↗
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
export function PaycomSettings() {
  return (
    <PluginSettingsForm
      pluginId="paycom"
      title="Paycom settings"
      description="Make Paycom work the way your team does."
      backHref="#/paycom"
      renderSection={(section) =>
        section === "sync" ? <ScheduleStatus /> : null
      }
    />
  );
}
