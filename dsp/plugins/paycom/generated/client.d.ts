// Generated from dispatch-plugin.json. Do not edit.
import type { Json, RequestOptions } from "dispatch-sdk";
export interface Client {
  "workforce.day"(input: { "query": { "date"?: string; "search"?: string; "attention"?: string; "lifecycleStatus"?: string; "limit"?: number; "offset"?: number; "sort"?: string; "direction"?: string; "department"?: string; "station"?: string } }, options?: RequestOptions): Promise<unknown>;
  "workforce.employees"(input: { "query": { "limit"?: number; "offset"?: number; "lifecycleStatus"?: string } }, options?: RequestOptions): Promise<unknown>;
  "workforce.employee"(input: { "code": string }, options?: RequestOptions): Promise<unknown>;
  "sync.status"(input: { "id": "paycom-main-workforce" }, options?: RequestOptions): Promise<unknown>;
  "sync.run_now"(input: { "id": "paycom-main-workforce"; "options"?: { "idempotencyKey"?: string } }, options?: RequestOptions): Promise<unknown>;
}
export function createClient(invoke: (action: string, input: Json, options?: RequestOptions) => Promise<unknown>): Client;
