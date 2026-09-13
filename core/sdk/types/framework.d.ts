export type FrameworkOperation = 'auth.request' | 'plugin.invoke' | 'plugin.collect' | 'plugin.read' | 'plugin.publish' | 'plugin.inspect' | 'plugin.evidence';
export interface FrameworkClient {
  request<T = unknown>(operation: FrameworkOperation, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T>;
}
/** Trusted DSP framework only. Plugin workers receive the narrower bound client. */
export function createFrameworkClient(options?: { socketPath?: string }): FrameworkClient;
