export interface BrowserTarget { id: string; url: string; webSocketDebuggerUrl: string }
export class CdpError extends Error { code: string }
export function boundedJson(url: string, options?: { method?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<any>;
export function createTarget(endpoint: string, url: string): Promise<BrowserTarget>;
export function validateTarget(value: unknown, endpoint: string): BrowserTarget;
export class CdpConnection {
  static connect(url: string, options?: { openTimeoutMs?: number; commandTimeoutMs?: number; signal?: AbortSignal }): Promise<CdpConnection>;
  command(method: string, params?: Record<string, unknown>): Promise<any>;
  evaluate(expression: string): Promise<any>;
  waitFor(method: string, predicate?: (event: any) => boolean, timeoutMs?: number): Promise<any>;
  close(reason?: string): void;
}
