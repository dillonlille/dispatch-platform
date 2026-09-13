export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Input = { [key: string]: Json };
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface SettingsOption {
  label: string;
  value: string | number;
  count?: number;
}
export type SettingsSources = Record<string, "default" | "override">;
export type SettingsTiming =
  "immediate" | "next_job" | "next_connection" | "schedule";
export interface SettingsCondition {
  field: string;
  equals: Json;
}
export type SettingsRule = {
  id: string;
  severity: "warning" | "error";
  message: string;
  when?: SettingsCondition;
} & (
  | { kind: "included"; field: string; selection: string }
  | { kind: "requires"; require: SettingsCondition }
);
export type SettingsPreview = {
  id: string;
  section: string;
  label: string;
  field: string;
} & (
  | { kind: "choice"; examples: { value: Json; text: string }[] }
  | { kind: "columns"; leading?: string }
  | { kind: "selection_count"; unit: string; groupLabel: string }
);
export interface SettingsField {
  id: string;
  label: string;
  description?: string;
  section: string;
  type: "boolean" | "integer" | "string" | "strings";
  default: Json;
  options?: SettingsOption[];
  optionsSource?: string;
  nullable?: boolean;
  ordered?: boolean;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  visibleWhen?: SettingsCondition;
  enabledWhen?: SettingsCondition;
  disabledReason?: string;
  applies?: SettingsTiming;
}
export interface SettingsDefinition {
  version: number;
  sections: { id: string; label: string; description?: string }[];
  fields: SettingsField[];
  optionsView?: string;
  rules?: SettingsRule[];
  previews?: SettingsPreview[];
  schedule?: { id: string; enabled: string; interval: string };
  migrations?: {
    fromVersion: number;
    rename?: Record<string, string>;
    remove?: string[];
    copy?: Record<string, string[]>;
    mapValues?: Record<string, { from: Json; to: Json }[]>;
    scale?: Record<string, number>;
    reset?: string[];
  }[];
}
export interface SettingsSnapshot<T = Input> {
  revision: number;
  definitionVersion: number;
  values: T;
  sources: SettingsSources;
  appliedRevision: number;
  updatedAt: number;
  updatedBy: string | null;
  definition: SettingsDefinition;
}
export interface SettingsUpdate {
  values: Input;
  sources?: SettingsSources;
  expectedRevision: number;
  definitionVersion: number;
  idempotencyKey: string;
}
export interface SettingsHistoryEntry {
  revision: number;
  definitionVersion: number;
  values: Input;
  sources: SettingsSources;
  updatedAt: number;
  updatedBy: string | null;
  actorName?: string;
  kind: "initial" | "owner" | "migration";
  canRestore: boolean;
  changes: {
    field: string;
    label: string;
    before: Json;
    after: Json;
    beforeSource: string | null;
    afterSource: string | null;
  }[];
}
export interface SettingsHistory {
  items: SettingsHistoryEntry[];
  nextBefore: number | null;
  currentRevision: number;
}
export interface Transport {
  request(
    message: { apiVersion: number; operation: string; input: Input },
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}
export interface BrowserSession {
  endpoint: string;
  protocol: "cdp";
  access: string;
  signal: AbortSignal;
}
export type StorageDirectory =
  "database" | "files" | "state" | "staging" | "published";
export interface StoragePort {
  database(name: string): unknown;
  files(name: string): unknown;
  directory?(kind: StorageDirectory): string;
}
export class DispatchError extends Error {
  code: string;
  recoverable: boolean;
}
export const API_VERSION: number;
export const SDK_VERSION: string;
export interface DispatchClient {
  capabilities(options?: RequestOptions): Promise<Json>;
  settings: {
    get<T = Input>(options?: RequestOptions): Promise<SettingsSnapshot<T>>;
  };
  connections: {
    status(connection: string, options?: RequestOptions): Promise<Json>;
    withSession<T>(
      options: { connection: string; ttlMs?: number; signal?: AbortSignal },
      useSession: (session: BrowserSession) => Promise<T>,
    ): Promise<T>;
  };
  jobs: {
    enqueue(
      action: string,
      input: Input,
      idempotencyKey: string,
      options?: RequestOptions,
    ): Promise<Json>;
    status(id: string, options?: RequestOptions): Promise<Json>;
    cancel(
      id: string,
      idempotencyKey: string,
      options?: RequestOptions,
    ): Promise<Json>;
    retry(
      id: string,
      idempotencyKey: string,
      options?: RequestOptions,
    ): Promise<Json>;
  };
  schedules: {
    list(options?: RequestOptions): Promise<Json>;
    status(id: string, options?: RequestOptions): Promise<Json>;
    run(id: string, input?: Input, options?: RequestOptions): Promise<Json>;
    set(
      id: string,
      definition: Input,
      idempotencyKey: string,
      options?: RequestOptions,
    ): Promise<Json>;
    remove(
      id: string,
      idempotencyKey: string,
      options?: RequestOptions,
    ): Promise<Json>;
  };
  actions: {
    invoke(
      action: string,
      input?: Input,
      options?: RequestOptions,
    ): Promise<Json>;
  };
  published: {
    read(view: string, query?: Input, options?: RequestOptions): Promise<Json>;
  };
  progress: { report(event: Input, options?: RequestOptions): Promise<Json> };
  log: { write(event: Input, options?: RequestOptions): Promise<Json> };
  storage?: StoragePort;
}
export function createDispatchClient(options: {
  transport: Transport;
  storage?: StoragePort;
  timeoutMs?: number;
}): DispatchClient;
