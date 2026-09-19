import type { ReactNode } from 'react';
import {
  ArrowUpFromLine,
  Building2,
  CalendarDays,
  FlaskConical,
  House,
  ScrollText,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { DspView, SessionView } from '../../../shared/contracts/index.js';
import { PaycomSettingsPage } from '../paycom-settings.js';
import { AuditPage, DiagnosticsPage, DspList, DspPicker, ReleasesPage } from '../platform.js';
import { SettingsPage } from '../settings.js';
import { ErrorBox } from '../ui/index.js';
import { title } from '../lib/format.js';
import { can } from './permissions.js';
import { HomePage, PaycomPage, TeamPage } from '../workspace.js';

type Access = { session: SessionView; view?: DspView };
type PageContext = { session: SessionView };
type DspPageContext = PageContext & { view: DspView; reopen: () => Promise<void> };
type Entry = {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** The navigation item to highlight for a page that has none of its own. */
  parent?: string;
  /** Whether the sidebar lists the page. */
  nav: boolean | ((access: Access) => boolean);
  /** Who may open the page; omitted means everyone in the scope. */
  permission?: (access: Access) => boolean;
};
type Route =
  | (Entry & { scope: 'dsp'; render: (context: DspPageContext) => ReactNode })
  | (Entry & { scope: 'platform'; render: (context: PageContext) => ReactNode });

const platformOwner = ({ session }: Access) => session.user.platformOwner;

// Every page is declared here once: address, label, navigation, access and component.
export const routes = [
  {
    id: 'overview',
    scope: 'dsp',
    label: 'Home Page',
    icon: House,
    nav: true,
    render: () => <HomePage />,
  },
  {
    id: 'paycom',
    scope: 'dsp',
    label: 'Timecard',
    icon: CalendarDays,
    nav: true,
    // The link stays put while a view loads; the page itself waits for the view.
    permission: ({ view }) => !view || can(view, 'timecard.view'),
    render: ({ view }) => <PaycomPage view={view} />,
  },
  {
    id: 'paycom-settings',
    scope: 'dsp',
    label: 'Timecard',
    parent: 'paycom',
    nav: false,
    permission: ({ view }) => can(view, 'timecard.manage'),
    render: ({ view }) => <PaycomSettingsPage dspId={view.dsp.id} />,
  },
  {
    id: 'team',
    scope: 'dsp',
    label: 'Team & Roles',
    icon: Users,
    nav: true,
    permission: ({ view }) =>
      can(view, 'members.invite') || can(view, 'members.manage') || can(view, 'roles.manage'),
    render: ({ view, reopen }) => <TeamPage view={view} reopen={reopen} />,
  },
  {
    id: 'settings',
    scope: 'dsp',
    label: 'Settings',
    icon: Settings,
    nav: true,
    render: ({ session, view }) => <SettingsPage session={session} view={view} />,
  },
  {
    id: 'dsps',
    scope: 'platform',
    label: 'DSPs',
    icon: Building2,
    nav: true,
    render: ({ session }) =>
      session.user.platformOwner ? <DspList /> : <DspPicker session={session} />,
  },
  {
    id: 'releases',
    scope: 'platform',
    label: 'Updates',
    icon: ArrowUpFromLine,
    nav: true,
    permission: platformOwner,
    render: () => <ReleasesPage />,
  },
  {
    id: 'jobs',
    scope: 'platform',
    label: 'Diagnostics',
    icon: FlaskConical,
    nav: true,
    permission: platformOwner,
    render: () => <DiagnosticsPage />,
  },
  {
    id: 'audit',
    scope: 'platform',
    label: 'Audit log',
    icon: ScrollText,
    nav: true,
    permission: platformOwner,
    render: () => <AuditPage />,
  },
  {
    id: 'account',
    scope: 'platform',
    label: 'Settings',
    icon: Settings,
    nav: platformOwner,
    render: ({ session }) => <SettingsPage session={session} />,
  },
] as const satisfies readonly Route[];

type Declared = (typeof routes)[number];
export type DspRouteId = Extract<Declared, { scope: 'dsp' }>['id'];
export type PlatformRouteId = Extract<Declared, { scope: 'platform' }>['id'];

const table: readonly Route[] = routes;
const allowed = (route: Route, access: Access) => !route.permission || route.permission(access);

export const findRoute = (scope: Route['scope'], page: string) =>
  table.find((route) => route.scope === scope && route.id === page);
export const routeLabel = (scope: Route['scope'], page: string) =>
  findRoute(scope, page)?.label ?? title(page);
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
