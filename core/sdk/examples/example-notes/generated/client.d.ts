// Generated from dispatch-plugin.json. Do not edit.
import type { Json, RequestOptions } from "dispatch-sdk";
export interface Client {
  "records.list"(input?: { "limit"?: number; "offset"?: number }, options?: RequestOptions): Promise<{ "items": Array<{ "id": number; "text": string }>; "total": number; "limit": number; "offset": number }>;
  "records.add"(input: { "text": string; "idempotencyKey": string }, options?: RequestOptions): Promise<{ "id": number; "text": string }>;
}
export function createClient(invoke: (action: string, input: Json, options?: RequestOptions) => Promise<unknown>): Client;
