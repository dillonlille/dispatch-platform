import type { ReactNode } from 'react';
import {
  Building2,
  CalendarDays,
  FlaskConical,
  House,
  ScrollText,
  Settings,
  Shirt,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { DspView, SessionView } from '../../../shared/contracts/index.js';
import { AuditPage } from '../features/audit/index.js';
import { HomePage } from '../features/home/index.js';
import { DiagnosticsPage, DspList, DspPicker } from '../features/platform/index.js';
import { SettingsPage } from '../features/settings/index.js';
import { TeamPage } from '../features/team/index.js';
import { UniformInventoryPage } from '../features/uniforms/index.js';
import { PaycomPage, PaycomSettingsPage } from '../features/timecard/index.js';
import { ErrorBox } from '../ui/index.js';
import { can } from './permissions.js';
import { routeMeta, type DspRouteId, type PlatformRouteId, type RouteMeta } from './route-meta.js';

type Access = { session: SessionView; view?: DspView };
type PageContext = { session: SessionView };
type DspPageContext = PageContext & { view: DspView; reopen: () => Promise<void> };
type Entry<Context> = {
  icon?: LucideIcon;
  /** Whether the sidebar lists the page. */
  nav: boolean | ((access: Access) => boolean);
  /** Who may open the page; omitted means everyone in the scope. */
  permission?: (access: Access) => boolean;
  render: (context: Context) => ReactNode;
};
type Route =
  | (RouteMeta & { scope: 'dsp' } & Entry<DspPageContext>)
  | (RouteMeta & { scope: 'platform' } & Entry<PageContext>);

const platformOwner = ({ session }: Access) => session.user.platformOwner;

// Every page declared in route-meta.ts gets its navigation, access and component here.
const dspPages: Record<DspRouteId, Entry<DspPageContext>> = {
  uniforms: {
    icon: Shirt,
    nav: true,
    render: ({ view }) => <UniformInventoryPage key={view.token} view={view} />,
  },
  overview: {
    icon: House,
    nav: true,
    render: () => <HomePage />,
  },
  paycom: {
    icon: CalendarDays,
    nav: true,
    // The link stays put while a view loads; the page itself waits for the view.
    permission: ({ view }) => !view || can(view, 'timecard.view'),
    render: ({ view }) => <PaycomPage view={view} />,
  },
  'paycom-settings': {
    nav: false,
    permission: ({ view }) => can(view, 'timecard.manage'),
    render: ({ view }) => <PaycomSettingsPage dspId={view.dsp.id} />,
  },
  team: {
    icon: Users,
    nav: true,
    permission: ({ view }) =>
      can(view, 'members.invite') || can(view, 'members.manage') || can(view, 'roles.manage'),
    render: ({ view, reopen }) => <TeamPage view={view} reopen={reopen} />,
  },
  settings: {
    icon: Settings,
    nav: true,
    render: ({ session, view }) => <SettingsPage session={session} view={view} />,
  },
};
const platformPages: Record<PlatformRouteId, Entry<PageContext>> = {
  dsps: {
    icon: Building2,
    nav: true,
    render: ({ session }) =>
      session.user.platformOwner ? <DspList /> : <DspPicker session={session} />,
  },
  jobs: {
    icon: FlaskConical,
    nav: true,
    permission: platformOwner,
    render: () => <DiagnosticsPage />,
  },
  audit: {
    icon: ScrollText,
    nav: true,
    permission: platformOwner,
    render: () => <AuditPage />,
  },
  account: {
    icon: Settings,
    nav: platformOwner,
    render: ({ session }) => <SettingsPage session={session} />,
  },
};

const table: readonly Route[] = routeMeta.map((meta) =>
  meta.scope === 'dsp' ? { ...meta, ...dspPages[meta.id] } : { ...meta, ...platformPages[meta.id] },
);
const allowed = (route: Route, access: Access) => !route.permission || route.permission(access);

export const findRoute = (scope: Route['scope'], page: string) =>
  table.find((route) => route.scope === scope && route.id === page);
export const navigation = (scope: Route['scope'], access: Access) =>
  table.filter(
    (route) =>
      route.scope === scope &&
      (typeof route.nav === 'function' ? route.nav(access) : route.nav) &&
      allowed(route, access),
  );

/** The page for an address, or the app's wording for one this person cannot open. */
export function Page({
  page,
  reopen,
  ...context
}: PageContext & { page: string; view?: DspView; reopen: () => Promise<void> }) {
  const { session, view } = context;
  const route = findRoute(view ? 'dsp' : 'platform', page);
  const open = route && allowed(route, context) ? route : undefined;
  if (view)
    return open?.scope === 'dsp' ? (
      open.render({ ...context, view, reopen })
    ) : (
      <ErrorBox message="This page is not available for your role." />
    );
  if (open?.scope === 'platform') return open.render(context);
  // Members have one platform page: the DSPs they belong to.
  return session.user.platformOwner ? (
    <ErrorBox message="Page not found." />
  ) : (
    <DspPicker session={session} />
  );
}
