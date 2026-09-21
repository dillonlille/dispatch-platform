// The endpoints whose responses are generated from the backend's Rust types: each address
// is written once, next to the type it answers with. Other endpoints still call `api` and
// `useData` directly; move one here when its response gains a generated type.
import { api, useCachedData, useData } from './api.js';
import { useEffect } from 'react';
import { prefetchData } from './prefetch.js';
import { dataCache } from './data-cache.js';
import type {
  CollectionSchedule,
  CollectionSchedules,
  Connection,
  DspSummary,
  DspView,
  EmployeeTimecardPeriod,
  EmployeeTimecardResponse,
  Job,
  MailMessage,
  Membership,
  Permission,
  Role,
  SessionView,
} from '../../../shared/contracts/index.js';
import type { ScheduleInput } from '../../../shared/schedules.js';

export const getSession = () => api<SessionView>('/api/session');
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
  api<DspView>('/api/session/dsp', roleId ? { dspId, roleId } : { dspId });

export const usePlatformDsps = (poll = 0) => useData<DspSummary[]>('/api/platform/dsps', poll);
export const usePlatformMail = (poll = 0) => useData<MailMessage[]>('/api/platform/mail', poll);
/** Gives a failed message a fresh set of attempts, or drops it. */
export const retryMail = (id: string) => api(`/api/platform/mail/${id}/retry`, {});
export const discardMail = (id: string) => api(`/api/platform/mail/${id}/discard`, {});
export const usePlatformJobs = (poll = 0) => useData<Job[]>('/api/platform/jobs', poll);

export const useMembers = (poll = 0) => useData<Membership[]>('/api/dsp/members', poll);
export const inviteMember = (email: unknown, role: unknown) =>
  api('/api/dsp/members/invite', { email, role });
/** A null role removes the member from the DSP. */
export const setMemberRole = (member: string, role: string | null) =>
  api(`/api/dsp/members/${member}`, { role });

export const useRoles = (poll = 0) => useData<Role[]>('/api/dsp/roles', poll);
export const saveTeamRole = (
  id: string | undefined,
  role: { name: string; permissions: Permission[] },
) => api<Role>(id ? `/api/dsp/roles/${id}` : '/api/dsp/roles', role);
export const removeRole = (id: string) => api(`/api/dsp/roles/${id}/remove`, {});

const schedules = '/api/dsp/schedules';
export const useSchedules = (dspId: string) =>
  useData<CollectionSchedules>(schedules, 10000, dspId, dspId);
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
  useData<Connection>(
    provider === 'paycom' ? '/api/dsp/connections' : connectionUrl(provider),
    poll,
  );
