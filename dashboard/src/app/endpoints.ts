import { performancePolicy } from '../lib/performance-policy.js';
import type {
  UniformUpdates,
  UniformInventory,
  UniformInput,
  UniformAdjustment,
  UniformHistory,
} from '../../../shared/contracts/uniforms.js';
import type { PaycomPreferences, PaycomSettings } from '../../../shared/contracts/paycom.js';
import type { MealComparison } from '../../../shared/contracts/meals.js';
// The endpoints whose responses are generated from the backend's Rust types: each address
// is written once, next to the type it answers with. Other endpoints still call `api` and
// `useData` directly; move one here when its response gains a generated type.
import { api, useCachedData, useData } from './api.js';
import { useEffect } from 'react';
import { prefetchData } from './prefetch.js';
import { dataCache } from './data-cache.js';
import type {
  AuditPage,
  PlatformHealth,
  CollectionSchedule,
  CollectionSchedules,
  Connection,
  CollectionUpdates,
  DspSummary,
  DspView,
  EmployeeTimecardPeriod,
  EmployeesResponse,
  DailyTimecards,
  EmployeeTimecardResponse,
  Job,
  MailMessage,
  Membership,
  Permission,
  Role,
  SessionView,
  AccountSession,
} from '../../../shared/contracts/index.js';
import type { ScheduleInput } from '../../../shared/contracts/schedules.js';

export const getCollectionUpdates = (after: string, signal: AbortSignal) =>
  api<CollectionUpdates>(
    `/api/dsp/collection-updates?after=${encodeURIComponent(after)}`,
    undefined,
    signal,
  );

export const getSession = () => api<SessionView>('/api/session');
export const useAccountSessions = () => useData<AccountSession[]>('/api/auth/security/sessions');
export const employeeTimecardUrl = (code: string, period?: EmployeeTimecardPeriod | null) =>
  `/api/dsp/employees/${encodeURIComponent(code)}${period ? `?from=${period.from}&to=${period.to}` : ''}`;
export const syncEmployeeTimecard = (
  code: string,
  period: EmployeeTimecardPeriod,
  requestId: string,
) => api<Job>(`/api/dsp/employees/${encodeURIComponent(code)}/sync`, { requestId, ...period });
export const useEmployeeTimecard = (
  code: string,
  period: EmployeeTimecardPeriod | null,
  refreshKey: string,
) => {
  const url = code ? employeeTimecardUrl(code, period) : '';
  const result = useCachedData<EmployeeTimecardResponse>(url, 0, refreshKey);
  useEffect(() => {
    if (!result.data) return;
    dataCache.alias(url, employeeTimecardUrl(code, result.data.period));
    if (!result.data.nextPeriod) dataCache.alias(url, employeeTimecardUrl(code));
  }, [url, code, result.data]);
  const previous = result.data?.previousPeriod;
  const next = result.data?.nextPeriod;
  useEffect(() => {
    prefetchData(
      [previous, next]
        .filter((period) => period != null)
        .map((period) => employeeTimecardUrl(code, period)),
    );
  }, [code, previous?.from, previous?.to, next?.from, next?.to]);
  return result;
};
export const openDsp = (dspId: string, roleId?: string) =>
  api<DspView>(
    '/api/session/dsp',
    roleId ? { dspId, roleId } : { dspId },
    AbortSignal.timeout(performancePolicy.readTimeoutMs),
  );

export const usePlatformDsps = (poll = 0) =>
  useCachedData<DspSummary[]>('/api/platform/dsps', poll);
export const usePlatformMail = (poll = 0) =>
  useCachedData<MailMessage[]>('/api/platform/mail', poll);
/** Gives a failed message a fresh set of attempts, or drops it. */
export const retryMail = (id: string) => api(`/api/platform/mail/${id}/retry`, {});
export const discardMail = (id: string) => api(`/api/platform/mail/${id}/discard`, {});
export const usePlatformJobs = (poll = 0) => useCachedData<Job[]>('/api/platform/jobs', poll);

export const useMembers = (poll = 0) => useCachedData<Membership[]>('/api/dsp/members', poll);
export const inviteMember = (email: unknown, role: unknown) =>
  api('/api/dsp/members/invite', { email, role });
/** A null role removes the member from the DSP. */
export const setMemberRole = (member: string, role: string | null) =>
  api(`/api/dsp/members/${member}`, { role });

export const useRoles = (poll = 0) => useCachedData<Role[]>('/api/dsp/roles', poll);
export const saveTeamRole = (
  id: string | undefined,
  role: { name: string; permissions: Permission[] },
) => api<Role>(id ? `/api/dsp/roles/${id}` : '/api/dsp/roles', role);
export const removeRole = (id: string) => api(`/api/dsp/roles/${id}/remove`, {});

const schedules = '/api/dsp/schedules';
export const useSchedules = (dspId: string) =>
  useCachedData<CollectionSchedules>(schedules, performancePolicy.recoveryPollMs, dspId);
export const getSchedules = () => api<CollectionSchedules>(schedules);
/** Saving an existing schedule names the revision it was read at. */
export const saveSchedule = (
  id: string | undefined,
  schedule: ScheduleInput & { revision?: number },
) => api<CollectionSchedule>(id ? `${schedules}/${id}` : schedules, schedule);
export const setScheduleEnabled = (id: string, enabled: boolean, revision: number) =>
  api<CollectionSchedule>(`${schedules}/${id}/enabled`, { enabled, revision });
export const removeSchedule = (id: string, revision: number) =>
  api(`${schedules}/${id}/remove`, { revision });

export const connectionUrl = (provider: Connection['provider']) =>
  `/api/dsp/connections/${provider}`;
export const useConnection = (provider: Connection['provider'], poll = 0) =>
  useCachedData<Connection>(
    provider === 'paycom' ? '/api/dsp/connections' : connectionUrl(provider),
    poll,
  );

export const useEmployees = (
  query: string,
  status: string,
  descending: boolean,
  refreshKey: string,
  page = 0,
) =>
  useCachedData<EmployeesResponse>(
    `/api/dsp/employees?q=${encodeURIComponent(query)}&status=${status}&limit=${performancePolicy.employeePageSize}&offset=${page * performancePolicy.employeePageSize}&direction=${descending ? 'desc' : 'asc'}`,
    0,
    refreshKey,
  );
export const dailyTimecardsUrl = (date: string) =>
  `/api/dsp/timecards?date=${date}&sort=name&direction=asc`;
export const useDailyTimecards = (date: string, refreshKey?: string | null) =>
  useCachedData<DailyTimecards>(
    dailyTimecardsUrl(date),
    performancePolicy.recoveryPollMs,
    refreshKey,
  );
export const mealComparisonUrl = (date: string) =>
  `/api/dsp/paycom/meal-breaks?date=${encodeURIComponent(date)}`;
export const useMealComparison = (date: string, refreshKey?: string | null) =>
  useCachedData<MealComparison>(
    mealComparisonUrl(date),
    performancePolicy.recoveryPollMs,
    refreshKey,
  );

const paycomSettings = '/api/dsp/paycom/settings';
/** Editors use a fresh DSP-scoped read; the timecard view shares its session cache. */
export const usePaycomSettings = (dspId?: string) =>
  useData<PaycomSettings>(
    paycomSettings,
    120000,
    dspId,
    dspId ?? paycomSettings,
    dspId === undefined,
  );
export const savePaycomSettings = (revision: number, values: PaycomPreferences) =>
  api<PaycomSettings>(paycomSettings, { revision, values });
export const usePlatformHealth = (poll = 0) =>
  useData<PlatformHealth>('/api/platform/health', poll);
const audit = '/api/platform/audit';
export const useAuditPage = (query: URLSearchParams, limit: number) =>
  useData<AuditPage>(`${audit}?${query}&limit=${limit}`, 10000);
export const exportAudit = (query: URLSearchParams) =>
  api<AuditPage>(`${audit}/export`, Object.fromEntries(query));

// Each active inventory page holds one long poll. Unchanged quantities send no rows.
export const getUniformUpdates = (after: number | undefined, signal: AbortSignal) =>
  api<UniformUpdates>(
    `/api/dsp/uniforms/updates${after === undefined ? '' : `?after=${after}`}`,
    undefined,
    signal,
  );
export const initializeUniforms = (starter: boolean) =>
  api<UniformInventory>('/api/dsp/uniforms/initialize', { starter });
export const saveUniform = (id: string | undefined, input: UniformInput) =>
  api<UniformInventory>(`/api/dsp/uniforms${id ? `/${id}` : ''}`, input);
export const archiveUniform = (id: string, revision: number) =>
  api<UniformInventory>(`/api/dsp/uniforms/${id}/archive`, { revision });
export const adjustUniform = (id: string, delta: 1 | -1, requestId: string, signal?: AbortSignal) =>
  api<UniformAdjustment>(`/api/dsp/uniforms/stock/${id}`, { delta, requestId }, signal);
export const useUniformHistory = (before: number | null, revision: number) =>
  useData<UniformHistory>(
    `/api/dsp/uniforms/history${before === null ? '' : `?before=${before}`}`,
    0,
    String(revision),
  );
