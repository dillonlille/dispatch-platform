/** Cache dependencies, independent of React and transport. */
import type { CollectionChange } from '../../../shared/contracts/index.js';
export type { CollectionChange };
const path = (url: string) => url.split('?')[0]!;
const begins = (url: string, ...prefixes: string[]) =>
  prefixes.some((p) => path(url).startsWith(p));
export const collectionData = (url: string) =>
  begins(
    url,
    '/api/dsp/timecards',
    '/api/dsp/employees',
    '/api/dsp/paycom/meal-breaks',
    '/api/dsp/paycom/settings',
    '/api/dsp/jobs',
    '/api/dsp/paycom/status',
  );

export function collectionAffects(url: string, changes: CollectionChange[]) {
  const route = path(url);
  if (!collectionData(url)) return false;
  if (begins(url, '/api/dsp/jobs', '/api/dsp/paycom/status')) return true;
  return changes.some((change) => {
    if (change.provider === 'all') return true;
    if (change.provider === 'cortex' && route !== '/api/dsp/paycom/meal-breaks') return false;
    if (route === '/api/dsp/paycom/settings') return Boolean(change.roster);
    if (route === '/api/dsp/employees') return Boolean(change.roster);
    if (route.startsWith('/api/dsp/employees/'))
      return (
        !change.employeeCode ||
        decodeURIComponent(route.slice('/api/dsp/employees/'.length)) === change.employeeCode
      );
    const day = new URLSearchParams(url.split('?')[1]).get('date');
    return !day || !change.dates?.length || change.dates.includes(day);
  });
}

export function mutationAffects(mutation: string, url: string) {
  const write = path(mutation);
  if (write === '/api/session/dsp' || write.startsWith('/api/auth/')) return false;
  if (write.startsWith('/api/dsp/uniforms')) return begins(url, '/api/dsp/uniforms');
  if (write === '/api/dsp/paycom/settings') return collectionData(url) || path(url) === write;
  if (write === '/api/dsp/paycom/employee-links') return begins(url, '/api/dsp/paycom/meal-breaks');
  if (write.startsWith('/api/dsp/jobs') || write.endsWith('/sync') || write.endsWith('/collect'))
    return (
      begins(url, '/api/dsp/jobs', '/api/dsp/paycom/status') ||
      (write.endsWith('/sync') && path(url) === write.slice(0, -5))
    );
  if (write.startsWith('/api/dsp/connections'))
    return begins(
      url,
      '/api/dsp/connections',
      '/api/dsp/jobs',
      '/api/dsp/paycom/status',
      '/api/dsp/schedules',
    );
  if (write.startsWith('/api/dsp/schedules')) return begins(url, '/api/dsp/schedules');
  if (begins(write, '/api/dsp/members', '/api/dsp/roles', '/api/dsp/invitations'))
    return begins(url, '/api/dsp/members', '/api/dsp/roles', '/api/dsp/invitations');
  if (write.startsWith('/api/platform/')) return url.startsWith('/api/platform/');
  // Unclassified DSP edits conservatively revalidate their DSP, not platform pages.
  return write.startsWith('/api/dsp/') && url.startsWith('/api/dsp/');
}
