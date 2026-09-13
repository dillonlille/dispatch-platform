import type { DispatchClient, Json } from './index';
import type { Operation } from './operations';
export function definePlugin(options: {
  actions: Operation[];
  handlers: Record<string, (context: { dispatch: DispatchClient; input: Record<string, Json>; signal?: AbortSignal }) => Promise<Json> | Json>;
  initialize?(context: { dispatch: DispatchClient; timezone: string }): Promise<boolean>;
}): {
  initialize(context: { dispatch: DispatchClient; timezone: string }): Promise<boolean>;
  createPlugin(context: { dispatch: DispatchClient }): {
    invoke(action: string, input: unknown, options?: { signal?: AbortSignal }): Promise<
      { contractVersion: 1; ok: true; status: string; data: Json } |
      { contractVersion: 1; ok: false; status: string; data: null; error: { code: string; recoverable: boolean } }>;
  };
};
