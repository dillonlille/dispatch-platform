import { useBrowserUpdate } from './browser-update.js';
import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  House,
  CalendarDays,
  ArrowUpFromLine,
  Building2,
  Settings,
  Users,
  X,
  FlaskConical,
} from 'lucide-react';
import type { DspSummary, DspView, SessionView } from '../../shared/contracts/index.js';
import { api, credentials, ApiError } from './api.js';
import { AuthScreen } from './auth.js';
import {
  DspList,
  JobsPage,
  AuditPage,
  ReleasesPage,
  DiagnosticsPage,
  type Perform,
} from './platform.js';
import { EmployeesPage, TimecardsPage, ConnectionsPage } from './dsp.js';
import { Badge, Header, Loading, ErrorBox, can } from './ui.js';
import './styles.css';
import { DspOnboarding } from './onboarding.js';
import { PaycomSettingsPage } from './paycom-settings.js';
import { Shell } from './shell.js';
import { SettingsPage } from './settings.js';
import { PaycomPage, HomePage, TeamPage } from './workspace.js';
type Session = SessionView;
import { readAppearance, applyAppearance } from './appearance.js';
import { initializePreferences } from './preferences.js';
function App() {
  const [, setPreferencesRevision] = useState(0);
  const [session, setSession] = useState<Session | null>(),
    [view, setView] = useState<DspView>(),
    [route, setRoute] = useState(window.location.hash.slice(1) || 'dsps'),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [switching, setSwitching] = useState(false);
  useEffect(() => {
    const id = session?.user.id ?? 'signed-out';
    initializePreferences(id);
    const apply = () => applyAppearance(readAppearance(id));
    const media = matchMedia('(prefers-color-scheme: dark)');
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('dispatch-appearance', apply);
    return () => {
      media.removeEventListener('change', apply);
      window.removeEventListener('dispatch-appearance', apply);
    };
  }, [session?.user.id]);
  useEffect(() => {
    const changed = () => setPreferencesRevision((value) => value + 1);
    window.addEventListener('dispatch-preferences', changed);
    return () => window.removeEventListener('dispatch-preferences', changed);
  }, []);
  const load = useCallback(async (afterLogin = false) => {
    try {
      const next = await api<Session>('/api/session');
      credentials(next.csrf);
      initializePreferences(next.user.id);
      setSession(next);
      if (
        !next.user.platformOwner &&
        (afterLogin || !/^#(?:invite\?|reset\?|signin)/.test(window.location.hash)) &&
        !window.location.hash.startsWith('#dsp/') &&
        next.dsps.length === 1
      )
        window.location.hash = `dsp/${next.dsps[0]!.id}/overview`;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        credentials('');
        setSession(null);
      } else setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const changed = () => {
      setRoute(window.location.hash.slice(1) || 'dsps');
      setError('');
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [load]);
  const dspId = route.startsWith('dsp/') ? route.split('/')[1] : undefined,
    page = (dspId ? route.split('/')[2] || 'overview' : route).split('?')[0]!;
  useBrowserUpdate(Boolean(session) && (!dspId || Boolean(view)) && !switching);
  const reopen = useCallback(async () => {
    if (!session || !dspId) return;
    const next = await api<DspView>('/api/session/dsp', { dspId });
    if (window.location.hash.split('/')[1] !== dspId) return;
    credentials(session.csrf, next.token);
    setView(next);
  }, [session, dspId]);
  useEffect(() => {
    // Role and membership edits expire every open view of the DSP; reopening
    // picks up the member's new permissions without a manual reload.
    const expired = () => void reopen().catch(() => undefined);
    window.addEventListener('dispatch-view-expired', expired);
    return () => window.removeEventListener('dispatch-view-expired', expired);
  }, [reopen]);
  useEffect(() => {
    const signedOut = () => {
      credentials('');
      setSession(null);
      setView(undefined);
    };
    window.addEventListener('dispatch-signed-out', signedOut);
    return () => window.removeEventListener('dispatch-signed-out', signedOut);
  }, []);
  useEffect(() => {
    setView(undefined);
    if (!session) return;
    credentials(session.csrf);
    if (!dspId) return;
    let active = true;
    setSwitching(true);
    void api<DspView>('/api/session/dsp', { dspId })
      .then((next) => {
        if (active) {
          credentials(session.csrf, next.token);
          setView(next);
        }
      })
      .catch((error) => {
        if (active) setError((error as Error).message);
      })
      .finally(() => {
        if (active) setSwitching(false);
      });
    return () => {
      active = false;
    };
  }, [session, dspId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const perform: Perform = async (work, success) => {
    setError('');
    try {
      await work();
      if (success) setNotice(success);
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  };
  function open(dsp: DspSummary) {
    window.location.hash = `dsp/${dsp.id}/overview`;
  }
  function platform() {
    window.location.hash = 'dsps';
  }
  if (session === undefined)
    return (
      <>
        <Loading />
        <ErrorBox message={error} />
      </>
    );
  if (
    session === null ||
    route === 'signin' ||
    route.startsWith('invite?') ||
    route.startsWith('reset?')
  )
    return <AuthScreen onLogin={() => load(true)} />;
  const canCollect = can(view, 'collections.run'),
    // The link stays put while a view loads; the page itself waits for the view.
    canViewTimecard = !view || can(view, 'timecard.view'),
    canTeam =
      can(view, 'members.invite') || can(view, 'members.manage') || can(view, 'roles.manage');
  if (view?.profile?.setupRequired && can(view, 'settings.manage'))
    return <DspOnboarding complete={reopen} />;
  const nav = dspId
    ? [
        { id: 'overview', label: 'Home Page', icon: House },
        ...(canViewTimecard ? [{ id: 'paycom', label: 'Timecard', icon: CalendarDays }] : []),
        ...(canCollect ? [{ id: 'jobs', label: 'Collections', icon: FlaskConical }] : []),
        ...(canTeam ? [{ id: 'team', label: 'Team & Roles', icon: Users }] : []),
        { id: 'settings', label: 'Settings', icon: Settings },
      ]
    : [
        { id: 'dsps', label: 'DSPs', icon: Building2 },
        ...(session.user.platformOwner
          ? [
              { id: 'releases', label: 'Updates', icon: ArrowUpFromLine },
              { id: 'jobs', label: 'Diagnostics', icon: FlaskConical },
              { id: 'account', label: 'Settings', icon: Settings },
            ]
          : []),
      ];
  async function logout() {
    await api('/api/auth/logout', {});
    credentials('');
    setSession(null);
    setView(undefined);
    window.location.hash = '';
  }
  return (
    <Shell
      session={session}
      view={view}
      dspId={dspId}
      page={page}
      navigation={nav}
      logout={() => void perform(logout)}
      exitView={platform}
    >
      <ErrorBox message={error} />
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {dspId ? (
        switching ? (
          <Loading />
        ) : view ? (
          <div key={`${view.dsp.id}:${view.dsp.revision}`}>
            {page === 'overview' ? (
              <HomePage />
            ) : page === 'paycom' && canViewTimecard ? (
              <PaycomPage view={view} perform={perform} canCollect={canCollect} />
            ) : page === 'paycom-settings' && can(view, 'timecard.manage') ? (
              <PaycomSettingsPage dspId={view.dsp.id} />
            ) : page === 'team' && canTeam ? (
              <TeamPage view={view} perform={perform} reopen={reopen} />
            ) : page === 'employees' && canViewTimecard ? (
              <EmployeesPage />
            ) : page === 'timecards' && canViewTimecard ? (
              <TimecardsPage timezone={view.dsp.timezone} />
            ) : page === 'connections' && can(view, 'connections.manage') ? (
              <ConnectionsPage perform={perform} development={session.providerMode === 'fixture'} />
            ) : page === 'jobs' && canCollect ? (
              <JobsPage platform={false} perform={perform} canCollect={canCollect} />
            ) : page === 'settings' ? (
              <SettingsPage session={session} view={view} perform={perform} />
            ) : (
              <ErrorBox message="This page is not available for your role." />
            )}
          </div>
        ) : null
      ) : page === 'account' ? (
        <SettingsPage session={session} perform={perform} />
      ) : session.user.platformOwner ? (
        page === 'dsps' ? (
          <DspList open={open} perform={perform} />
        ) : page === 'jobs' ? (
          <DiagnosticsPage perform={perform} />
        ) : page === 'releases' ? (
          <ReleasesPage />
        ) : page === 'audit' ? (
          <AuditPage />
        ) : (
          <ErrorBox message="Page not found." />
        )
      ) : (
        <>
          <Header title="Your DSPs" />
          <div className="workspace-grid">
            {session.dsps
              .filter((d) => d.status === 'active')
              .map((dsp) => (
                <button className="workspace-card" key={dsp.id} onClick={() => open(dsp)}>
                  <Building2 />
                  <strong>{dsp.name}</strong>
                  <Badge value={dsp.environment} />
                </button>
              ))}
          </div>
          {!session.dsps.length && (
            <p>Your account has no DSP memberships. Ask your DSP owner for an invitation.</p>
          )}
        </>
      )}
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
