import type { DspRouteId, PlatformRouteId } from './route-meta.js';

export const dspHash = (
  dspId: string,
  page: DspRouteId = 'overview',
  query?: Record<string, string>,
) => `#dsp/${dspId}/${page}${query ? `?${new URLSearchParams(query)}` : ''}`;
export const platformHash = (page: PlatformRouteId = 'dsps') => `#${page}`;
export const signInHash = '#signin';

export function navigate(hash: string) {
  window.location.hash = hash;
}
/** Where the address points: `#dsp/<id>/<page>?…` inside a DSP, `#<page>?…` outside one. */
export function parseHash(hash: string) {
  const route = hash.replace(/^#/, '') || 'dsps';
  const dspId = route.startsWith('dsp/') ? route.split('/')[1] : undefined;
  return {
    route,
    dspId,
    page: (dspId ? route.split('/')[2] || 'overview' : route).split('?')[0]!,
  };
}
export const hashQuery = () => new URLSearchParams(window.location.hash.split('?')[1]);
/** Records a page's own state in the address without navigating. */
export function replaceHashQuery(query: Record<string, string>) {
  history.replaceState(
    {},
    '',
    `${location.pathname}${location.search}${location.hash.split('?')[0]}?${new URLSearchParams(query)}`,
  );
}
