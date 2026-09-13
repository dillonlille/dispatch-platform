import type { ComponentType, InputHTMLAttributes, ReactNode } from "react";
import type { UseQueryResult, UseMutationResult } from "@tanstack/react-query";
import type {
  Input,
  Json,
  SettingsField,
  SettingsOption,
  SettingsSnapshot,
  SettingsSources,
} from "./index";
export function usePluginSettings<T = Input>(
  pluginId: string,
  includeOptions?: boolean,
): {
  query: UseQueryResult<SettingsSnapshot<T>, Error>;
  options: UseQueryResult<Record<string, SettingsOption[]>, Error>;
  update: UseMutationResult<
    SettingsSnapshot<T>,
    Error,
    { values: T; snapshot: SettingsSnapshot<T>; sources?: SettingsSources }
  >;
  scope: string;
};
export const PluginSettingsField: ComponentType<{
  field: SettingsField;
  value: Json;
  options?: Record<string, SettingsOption[]>;
  disabled?: boolean;
  onChange(value: Json): void;
}>;
export const PluginSettingsForm: ComponentType<{
  pluginId: string;
  title: string;
  description?: string;
  backHref: string;
  renderSection?(
    section: string,
    values: Input,
    options: Record<string, SettingsOption[]>,
  ): ReactNode;
}>;
export interface Organization {
  id: string;
  name: string;
  status: string;
  timezone: string;
  stations: { code: string }[];
}
export interface Membership {
  id: string;
  organizationId: string;
  permissions: string[];
  roleName: string;
  roleKey?: string;
  organization: Organization;
}
export interface Session {
  authenticated: boolean;
  user: {
    id: string;
    name: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  memberships: Membership[];
  activeOrganizationId?: string;
  platformPermissions: string[];
  dspView?: { viewRef: string; access: "owner"; expiresAt: string };
  csrfToken?: string;
}
export class ApiError extends Error {
  code: string;
  status?: number;
  constructor(code: string, status?: number);
}
export function request<T>(path: string, options?: RequestInit): Promise<T>;
export function mutation<T>(
  path: string,
  method: string,
  body: unknown,
): Promise<T>;
export function idempotent<T>(
  slot: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T>;
export function activeMembership(session: Session): Membership | undefined;
export function has(
  membership: Membership | undefined,
  permission: string,
): boolean;
export function isDspOwner(session: Session): boolean;
export function useSession(): {
  session: Session;
  refresh(session?: Session): Promise<void>;
};
export function useTimezone(): {
  timeZone: string;
  deviceZone: string;
  preference: string | null;
  setPreference(value: string | null): void;
  storageUnavailable: boolean;
};
export function useBusinessToday(timeZone: string): string;
export function calendarDateLabel(date: string): string;
export function moveCalendarDate(date: string, days: number): string;
export function dateTime(
  value: string | number | Date,
  timeZone?: string,
): string;
export const Button: ComponentType<any>,
  Badge: ComponentType<any>,
  Tabs: ComponentType<any>,
  TabsList: ComponentType<any>,
  TabsTrigger: ComponentType<any>,
  TabsContent: ComponentType<any>;
export const Table: ComponentType<any>,
  TableHeader: ComponentType<any>,
  TableHead: ComponentType<any>,
  TableBody: ComponentType<any>,
  TableRow: ComponentType<any>,
  TableCell: ComponentType<any>;
export const EmptyState: ComponentType<any>,
  ErrorNotice: ComponentType<{ error: unknown }>,
  Loading: ComponentType,
  Notice: ComponentType<{ children?: ReactNode; error?: boolean }>;
export const PageHeading: ComponentType<any>,
  TextField: ComponentType<
    InputHTMLAttributes<HTMLInputElement> & { label: string }
  >;

export function invokePluginOperation(pluginId: string, action: string, input: unknown,
  options?: { signal?: AbortSignal }): Promise<{ ok: true; data: unknown }>;
