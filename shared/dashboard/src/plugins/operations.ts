import { mutation } from "../lib/api.ts";

export async function invokePluginOperation(
  pluginId: string,
  action: string,
  input: unknown,
  options?: { signal?: AbortSignal },
) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(pluginId) || !/^[a-z][a-z0-9_.]{0,63}$/.test(action))
    throw new Error("Invalid plugin operation");
  return { ok: true as const, data: await mutation<unknown>(`/api/plugins/${pluginId}/${action}`, "POST", input, options) };
}
