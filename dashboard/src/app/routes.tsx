import { lazy, Suspense, type ReactNode } from 'react';
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
import { ErrorBox, Loading, PageBoundary } from '../ui/index.js';
import { can } from './permissions.js';
import { routeMeta, type DspRouteId, type PlatformRouteId, type RouteMeta } from './route-meta.js';

const loadAudit = () => import('../features/audit/index.js');
const AuditPage = lazy(() => loadAudit().then((module) => ({ default: module.AuditPage })));
const loadHome = () => import('../features/home/index.js');
const HomePage = lazy(() => loadHome().then((module) => ({ default: module.HomePage })));
const loadPlatform = () => import('../features/platform/index.js');
const DiagnosticsPage = lazy(() =>
  loadPlatform().then((module) => ({ default: module.DiagnosticsPage })),
);
const DspList = lazy(() => loadPlatform().then((module) => ({ default: module.DspList })));
const DspPicker = lazy(() => loadPlatform().then((module) => ({ default: module.DspPicker })));
const loadSettings = () => import('../features/settings/index.js');
const SettingsPage = lazy(() =>
  loadSettings().then((module) => ({ default: module.SettingsPage })),
);
const loadTeam = () => import('../features/team/index.js');
const TeamPage = lazy(() => loadTeam().then((module) => ({ default: module.TeamPage })));
const loadUniforms = () => import('../features/uniforms/index.js');
const UniformInventoryPage = lazy(() =>
  loadUniforms().then((module) => ({ default: module.UniformInventoryPage })),
);
const loadTimecard = () => import('../features/timecard/index.js');
const PaycomPage = lazy(() => loadTimecard().then((module) => ({ default: module.PaycomPage })));
const PaycomSettingsPage = lazy(() =>
  loadTimecard().then((module) => ({ default: module.PaycomSettingsPage })),
);

type Access = { session: SessionView; view?: DspView };
type PageContext = { session: SessionView };
type DspPageContext = PageContext & { view: DspView; reopen: () => Promise<void> };
type Entry<Context> = {
  icon?: LucideIcon;
  preload: () => Promise<unknown>;
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
    preload: loadUniforms,
    icon: Shirt,
    nav: true,
    render: ({ view }) => <UniformInventoryPage key={view.token} view={view} />,
  },
  overview: {
    preload: loadHome,
    icon: House,
    nav: true,
    render: () => <HomePage />,
  },
  paycom: {
    preload: loadTimecard,
    icon: CalendarDays,
    nav: true,
    // The link stays put while a view loads; the page itself waits for the view.
    permission: ({ view }) => !view || can(view, 'timecard.view'),
    render: ({ view }) => <PaycomPage view={view} />,
  },
  'paycom-settings': {
    preload: loadTimecard,
    nav: false,
    permission: ({ view }) => can(view, 'timecard.manage'),
    render: ({ view }) => <PaycomSettingsPage dspId={view.dsp.id} />,
  },
  team: {
    preload: loadTeam,
    icon: Users,
    nav: true,
    permission: ({ view }) =>
      can(view, 'members.invite') || can(view, 'members.manage') || can(view, 'roles.manage'),
    render: ({ view, reopen }) => <TeamPage view={view} reopen={reopen} />,
  },
  settings: {
    preload: loadSettings,
    icon: Settings,
    nav: true,
    render: ({ session, view }) => <SettingsPage session={session} view={view} />,
  },
};
const platformPages: Record<PlatformRouteId, Entry<PageContext>> = {
  dsps: {
    preload: loadPlatform,
    icon: Building2,
    nav: true,
    render: ({ session }) =>
      session.user.platformOwner ? <DspList /> : <DspPicker session={session} />,
  },
  jobs: {
    preload: loadPlatform,
    icon: FlaskConical,
    nav: true,
    permission: platformOwner,
    render: () => <DiagnosticsPage />,
  },
  audit: {
    preload: loadAudit,
    icon: ScrollText,
    nav: true,
    permission: platformOwner,
    render: () => <AuditPage />,
  },
  account: {
    preload: loadSettings,
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
function PageContent({
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

export function Page(props: Parameters<typeof PageContent>[0]) {
  return (
    <PageBoundary key={props.page}>
      <Suspense fallback={<Loading />}>
        <PageContent {...props} />
      </Suspense>
    </PageBoundary>
  );
}
