import { title } from '../lib/format.js';

export type RouteMeta = {
  id: string;
  scope: 'dsp' | 'platform';
  label: string;
  /** The navigation item to highlight for a page that has none of its own. */
  parent?: string;
};

// Every page's address and label, free of components so that any module may read them;
// app/routes.tsx gives each one its navigation, access and component.
export const routeMeta = [
  {
    id: 'overview',
    scope: 'dsp',
    label: 'Home Page',
  },
  {
    id: 'paycom',
    scope: 'dsp',
    label: 'Timecard',
  },
  {
    id: 'paycom-settings',
    scope: 'dsp',
    label: 'Timecard',
    parent: 'paycom',
  },
  {
    id: 'uniforms',
    scope: 'dsp',
    label: 'Uniform Inventory',
  },
  {
    id: 'team',
    scope: 'dsp',
    label: 'Team & Roles',
  },
  {
    id: 'settings',
    scope: 'dsp',
    label: 'Settings',
  },
  {
    id: 'dsps',
    scope: 'platform',
    label: 'DSPs',
  },
  {
    id: 'releases',
    scope: 'platform',
    label: 'Updates',
  },
  {
    id: 'jobs',
    scope: 'platform',
    label: 'Diagnostics',
  },
  {
    id: 'audit',
    scope: 'platform',
    label: 'Audit log',
  },
  {
    id: 'account',
    scope: 'platform',
    label: 'Settings',
  },
] as const satisfies readonly RouteMeta[];

type Declared = (typeof routeMeta)[number];
export type DspRouteId = Extract<Declared, { scope: 'dsp' }>['id'];
export type PlatformRouteId = Extract<Declared, { scope: 'platform' }>['id'];

const table: readonly RouteMeta[] = routeMeta;
export const routeLabel = (scope: RouteMeta['scope'], page: string) =>
  table.find((route) => route.scope === scope && route.id === page)?.label ?? title(page);
