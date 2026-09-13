import { installedPage } from "./loader.tsx";
import { useQuery } from "@tanstack/react-query";
import { activeMembership, has, isPlatform, request } from "@/lib/api";
import type { Session } from "@/lib/types";

export type PluginView = {
  id: string;
  name: string;
  version: string;
  latestVersion?: string;
  description: string;
  pages: {
    id: string;
    label: string;
    icon: "calendar" | "puzzle";
    permission: string;
  }[];
  state: "enabled" | "disabled" | "uninstalled";
  appliedState: "enabled" | "disabled" | "uninstalled";
  revision: number;
  pending: boolean;
  failureCode: string | null;
  available: boolean;
  hasSettings?: boolean;
  automaticUpdates?: boolean;
};
export function pluginPage(plugins: PluginView[], pageId: string) {
  const plugin = plugins.find(
    (item) => item.available && item.pages.some((page) => page.id === pageId),
  );
  return plugin ? installedPage(plugin.id, plugin.version, plugin.revision, pageId) : undefined;
}
export function pluginPages(plugins: PluginView[], session: Session) {
  const membership = activeMembership(session);
  return plugins
    .filter((plugin) => plugin.available)
    .flatMap((plugin) => plugin.pages)
    .filter(
      (page) =>
        has(membership, page.permission),
    );
}
export function usePlugins(session: Session) {
  const platform = isPlatform(session);
  const membership = activeMembership(session);
  return useQuery({
    queryKey: ["plugins", platform ? "platform" : membership?.organizationId],
    queryFn: ({ signal }) =>
      request<{ items: PluginView[] }>(
        platform ? "/api/platform/plugins" : "/api/organization/plugins",
        { signal },
      ),
    initialData:
      !platform && session.plugins ? { items: session.plugins } : undefined,
    enabled:
      session.authenticated &&
      (platform || (!!membership && has(membership, "dashboard.view"))),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.pending) ? 2000 : 15000,
  });
}
