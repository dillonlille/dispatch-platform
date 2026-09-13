import { workspaceRoutes, Workspace } from "./Workspace";
import { PasswordRecovery } from "@/pages/PasswordRecovery";
import { DefaultShellLayout } from "@/themes/defaults/ShellLayout";
import { PluginBoundary } from "@/plugins/loader";
import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  FlaskConical,
  ArrowUpFromLine,
  Database,
  Puzzle,
  Settings as SettingsIcon,
  House,
  CalendarDays,
  Users,
  Menu,
  LogOut,
  ChevronDown,
  Eye,
  type LucideIcon,
} from "lucide-react";
import {
  activeMembership,
  has,
  isPlatform,
  isDspOwner,
  mutation,
  queryClient,
  request,
  setSession,
  setDspView,
  ApiError,
} from "@/lib/api";
import type { Session } from "@/lib/types";
import { SessionContext } from "@/lib/session";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { TimezoneProvider } from "@/lib/timezone";
import { ReleasePopup } from "@/components/ReleasePopup";
import { Brand } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { PageHeading, Loading, ErrorNotice, Notice } from "@/components/shared";
import { Settings, DspOnboarding } from "@/pages/Settings";
import { Plugins } from "@/pages/Plugins";
import {
  pluginPage,
  pluginPages,
  usePlugins,
  type PluginView,
} from "@/plugins/registry";
import { Auth } from "@/pages/Auth";
export type NavItem = { id: string; label: string; icon: LucideIcon };
function Shell({
  session,
  refresh,
  hash,
  viewEnded,
}: {
  session: Session;
  refresh: (session?: Session) => Promise<void>;
  hash: string;
  viewEnded: boolean;
}) {
  const Layout =
    useTheme().themePack.components?.ShellLayout || DefaultShellLayout;
  const platform = isPlatform(session);
  const membership = activeMembership(session);
  const plugins = usePlugins(session);
  const installed = plugins.data?.items || [];
  const navigation = workspaceRoutes(session, installed);
  const requested = hash.replace(/^#\//, "").split(/[/?]/)[0];
  const route = navigation.find((n) => n.id === requested) || navigation[0];
  const PluginPage = pluginPage(installed, route.id);
  const [mobile, setMobile] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function exitView() {
    setBusy(true);
    setError(null);
    try {
      setDspView(null);
      await refresh();
      location.hash = "#/platform";
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (requested !== route.id) {
      history.replaceState(
        {},
        "",
        `${location.pathname}${location.search}#/${route.id}`,
      );
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    document.title = `${route.label} · Dispatch`;
    setMobile(false);
  }, [requested, route.id, route.label]);
  const nav = (
    <>
      <div className="sidebar-brand">
        <Brand />
        <p>
          {platform ? "Platform" : membership?.organization.name || "Workspace"}
        </p>
      </div>
      <nav className="nav-list" aria-label="Primary navigation">
        {navigation.map(({ id, label, icon: Icon }) => (
          <a
            key={id}
            href={`#/${id}`}
            aria-current={id === route.id ? "page" : undefined}
            className="nav-item"
            onClick={() => setMobile(false)}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="sidebar-account">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="account-button">
              <span className="avatar">
                {session.user.firstName?.[0]}
                {session.user.lastName?.[0]}
              </span>
              <span className="account-copy">
                <strong>{session.user.name}</strong>
                <span>
                  {session.dspView
                    ? "Platform owner · Viewing DSP"
                    : platform
                      ? "Platform owner"
                      : membership?.roleName || "No DSP access"}
                </span>
              </span>
              <ChevronDown aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <a href={`#/${platform ? "platform-settings" : "settings"}`}>
                  Account settings
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={async () => {
                  setBusy(true);
                  try {
                    await mutation("/api/auth/logout", "POST", {});
                    setDspView(null);
                    setSession(null);
                    queryClient.clear();
                    location.hash = "";
                    await refresh();
                  } catch (e) {
                    setError(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
  return (
    <SessionContext.Provider value={{ session, refresh }}>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <Layout
        navigation={nav}
        mobileNavigation={
          <Sheet open={mobile} onOpenChange={setMobile}>
            <SheetContent side="left" className="mobile-sidebar">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Your Dispatch workspace pages.
              </SheetDescription>
              {nav}
            </SheetContent>
          </Sheet>
        }
        banner={
          session.dspView && (
            <div
              className="dsp-view-banner"
              role="region"
              aria-label="DSP viewing mode"
            >
              <Eye aria-hidden="true" />
              <div>
                <strong>
                  Viewing {membership?.organization.name} as DSP owner
                </strong>
                <span>Full owner access. Changes are saved to this DSP.</span>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void exitView()}
              >
                {busy ? "Exiting…" : "Exit view"}
              </Button>
            </div>
          )
        }
        header={
          <>
            <Button
              className="mobile-menu"
              size="icon"
              variant="ghost"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu />
            </Button>
            <div className="breadcrumb">
              <span>
                {platform
                  ? "Platform"
                  : membership?.organization.name || "Workspace"}
              </span>
              <span aria-hidden="true">/</span>
              <strong>{route.label}</strong>
            </div>
          </>
        }
      >
        {viewEnded && !session.dspView && (
          <Notice>
            The DSP view expired or is no longer available. You’re back in the
            platform console.
          </Notice>
        )}
        <ErrorNotice error={error} />
        <Workspace route={route.id} hash={hash} installed={installed} />
      </Layout>
      <ReleasePopup />
    </SessionContext.Provider>
  );
}
export function App() {
  const [session, saveSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dashboardChanged,setDashboardChanged]=useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hash, setHash] = useState(location.hash);
  const [navigation, setNavigation] = useState(0);
  const [viewEnded, setViewEnded] = useState(false);
  const refresh = useCallback(async (next?: Session) => {
    let value: Session;
    try {
      value = next || (await request<Session>("/api/auth/session"));
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "dsp_view_unavailable")
        throw e;
      setViewEnded(true);
      value = await request<Session>("/api/auth/session");
    }
    if (value.dspView || !value.authenticated) setViewEnded(false);
    if (!value.authenticated) setDspView(null);
    const target = value.authenticated && !isPlatform(value) ? "dsp" : "core";
    if (window.__dispatchDashboard && window.__dispatchDashboard.product !== target) {
      window.location.reload(); return;
    }
    setSession(value);
    saveSession(value);
    setLoaded(true);
    setError(null);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => {
      setError(e);
      setLoaded(true);
    });
    const route = () => {
      setHash(location.hash);
      setNavigation((value) => value + 1);
    };
    const expired = () => {
      setSession(null);
      saveSession(null);
    };
    const viewEnded = () => {
      setViewEnded(true);
      void refresh().catch(setError);
    };
    window.addEventListener("hashchange", route);
    window.addEventListener("dispatch-session-expired", expired);
    window.addEventListener("dispatch-dsp-view-ended", viewEnded);
    return () => {
      window.removeEventListener("hashchange", route);
      window.removeEventListener("dispatch-session-expired", expired);
      window.removeEventListener("dispatch-dsp-view-ended", viewEnded);
    };
  }, [refresh]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const reload = () => {
      void refresh().catch(() => {});
    };
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [session?.authenticated, refresh]);
  useEffect(() => {
    if (!session?.dspView) return;
    const timer = window.setTimeout(
      () => void refresh().catch(setError),
      Math.max(0, Date.parse(session.dspView.expiresAt) - Date.now()) + 100,
    );
    return () => window.clearTimeout(timer);
  }, [session?.dspView?.expiresAt, refresh]);
  useEffect(() => {
    if(!session?.authenticated || !window.__dispatchDashboard)return;
    let cancelled=false;
    const check=async()=>{try{const current=await request<{product:string;digest:string}>("/api/dashboard?identity=1");
      if(!cancelled)setDashboardChanged(current.digest!==window.__dispatchDashboard.digest);
    }catch{ /* Normal session/error handling owns authentication failures. */ }};
    void check(); const timer=window.setInterval(check,30000);
    return ()=>{cancelled=true;window.clearInterval(timer);};
  },[session?.authenticated,session?.activeOrganizationId,session?.dspView?.viewRef]);
  function renderContent() {
    if (!loaded)
      return (
        <div className="initial-loading">
          <Brand />
          <Loading />
        </div>
      );
    if (error)
      return (
        <main className="initial-loading">
          <Brand />
          <ErrorNotice error={error} />
          <Button onClick={() => void refresh().catch(setError)}>
            Try again
          </Button>
        </main>
      );
    if (
      hash === "#/forgot-password" ||
      hash === "#/reset-password" ||
      hash.startsWith("#/reset-password/")
    )
      return (
        <PasswordRecovery
          key={`${hash}:${navigation}`}
          hash={hash}
          session={session}
          refresh={refresh}
        />
      );
    const token =
      /^#\/invitation\/([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] || null;
    if (!session?.authenticated || token)
      return <Auth session={session} refresh={refresh} token={token} />;
    if (
      !session.dspView &&
      hash === "#/onboarding" &&
      session.memberships.some(
        (m) =>
          m.organizationId === session.activeOrganizationId &&
          m.organization.status !== "suspended" &&
          m.permissions.includes("organization.owner"),
      )
    )
      return (
        <SessionContext.Provider value={{ session, refresh }}>
          <DspOnboarding />
        </SessionContext.Provider>
      );
    return (
      <Shell
        key={`${session.user.id}:${session.dspView?.viewRef || session.activeOrganizationId || "platform"}`}
        session={session}
        refresh={refresh}
        hash={hash}
        viewEnded={viewEnded}
      />
    );
  }
  const userId = session?.authenticated ? session.user.id : null;
  return <ThemeProvider userId={userId}><TimezoneProvider userId={userId}>{dashboardChanged && <div role="status" className="border-b bg-card p-3 text-center text-sm">An update is ready. Refresh before making further changes. <Button size="sm" onClick={()=>location.reload()}>Refresh dashboard</Button></div>}{renderContent()}</TimezoneProvider></ThemeProvider>;
}
