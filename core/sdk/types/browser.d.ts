import type {
  DispatchClient,
  Transport,
  SettingsUpdate,
  SettingsHistory,
  SettingsSnapshot,
  RequestOptions,
} from "./index";
export function createDashboardClient(options: {
  transport: Transport;
  timeoutMs?: number;
}): {
  settings: DispatchClient["settings"] & {
    history(
      beforeRevision?: number | null,
      options?: RequestOptions,
    ): Promise<SettingsHistory>;
    update(
      input: SettingsUpdate,
      options?: RequestOptions,
    ): Promise<SettingsSnapshot>;
  };
  actions: DispatchClient["actions"];
  published: DispatchClient["published"];
  jobs: Pick<DispatchClient["jobs"], "status">;
  connections: Pick<DispatchClient["connections"], "status">;
};
