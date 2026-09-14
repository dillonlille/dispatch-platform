import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Layers3,
  Building2,
  ListTodo,
  GitBranch,
  History,
  Settings,
  Users,
  Clock3,
  Link2,
  LayoutDashboard,
  ChevronDown,
  LogOut,
  Menu,
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
  HealthPanel,
  type Perform,
} from './platform.js';
import { Overview, EmployeesPage, TimecardsPage, ConnectionsPage, DspSettings } from './dsp.js';
import { Badge, Header, Loading, ErrorBox, Section, title } from './ui.js';
import './styles.css';
type Session = SessionView & { separatePreview?: boolean };
const userFullName = (user: SessionView['user']) => `${user.firstName} ${user.lastName}`;
function App() {
  const [session, setSession] = useState<Session | null>(),
    [view, setView] = useState<DspView>(),
    [route, setRoute] = useState(window.location.hash.slice(1) || 'dsps'),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [mobile, setMobile] = useState(false),
    [switching, setSwitching] = useState(false);
  const load = useCallback(async (afterLogin = false) => {
    try {
      const next = await api<Session>('/api/session');
      credentials(next.csrf);
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
      setMobile(false);
      setError('');
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [load]);
  const dspId = route.startsWith('dsp/') ? route.split('/')[1] : undefined,
    page = dspId ? route.split('/')[2] || 'overview' : route;
  const reopen = useCallback(async () => {
    if (!session || !dspId) return;
    const next = await api<DspView>('/api/session/dsp', { dspId });
    if (window.location.hash.split('/')[1] !== dspId) return;
    credentials(session.csrf, next.token);
    setView(next);
  }, [session, dspId]);
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
  const navigate = (next: string) => {
    window.location.hash = dspId ? `dsp/${dspId}/${next}` : next;
  };
  function open(dsp: DspSummary) {
    const prefix = dsp.environment === 'preview' && session?.separatePreview ? '/preview/' : '/';
    if (window.location.pathname !== prefix && session?.separatePreview) {
      window.location.assign(`${prefix}#dsp/${dsp.id}/overview`);
      return;
    }
    window.location.hash = `dsp/${dsp.id}/overview`;
  }
  function platform() {
    if (window.location.pathname === '/preview/') {
      window.location.assign('/#dsps');
      return;
    }
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
  const owner = view?.role === 'owner' || view?.role === 'platform_owner',
    canCollect = owner || view?.role === 'manager';
  const nav = dspId
    ? [
        { id: 'overview', label: 'Overview', icon: LayoutDashboard },
        { id: 'employees', label: 'Employees', icon: Users },
        { id: 'timecards', label: 'Timecards', icon: Clock3 },
        ...(owner ? [{ id: 'connections', label: 'Connections', icon: Link2 }] : []),
        { id: 'jobs', label: 'Jobs', icon: ListTodo },
        ...(owner ? [{ id: 'settings', label: 'DSP settings', icon: Settings }] : []),
      ]
    : [
        { id: 'dsps', label: 'DSPs', icon: Building2 },
        ...(session.user.platformOwner
          ? [
              { id: 'jobs', label: 'Jobs', icon: ListTodo },
              { id: 'releases', label: 'Releases', icon: GitBranch },
              { id: 'audit', label: 'Audit log', icon: History },
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
    <div className="app">
      <button
        className={`sidebar-scrim ${mobile ? 'shown' : ''}`}
        aria-label="Close navigation"
        onClick={() => setMobile(false)}
      />
      <aside className={`sidebar ${mobile ? 'shown' : ''}`}>
        <a
          className="brand"
          href="#dsps"
          onClick={(event) => {
            event.preventDefault();
            platform();
          }}
        >
          <Layers3 size={25} />
          Dispatch
        </a>
        <div className="workspace-switch">
          <label htmlFor="dsp-switch">WORKSPACE</label>
          <div>
            <select
              id="dsp-switch"
              aria-label="Switch DSP"
              value={dspId ?? ''}
              onChange={(event) => {
                const dsp = session.dsps.find((d) => d.id === event.target.value);
                if (dsp) open(dsp);
                else platform();
              }}
            >
              <option value="">
                {session.user.platformOwner ? 'Platform' : 'Your workspaces'}
              </option>
              {session.dsps
                .filter((d) => d.status === 'active')
                .map((dsp) => (
                  <option value={dsp.id} key={dsp.id}>
                    {dsp.name}
                  </option>
                ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <a
              key={item.id}
              className={page === item.id ? 'active' : ''}
              href={`#${dspId ? `dsp/${dspId}/` : ''}${item.id}`}
            >
              <item.icon size={18} />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a href="#account" className={page === 'account' ? 'active' : ''}>
            <Settings size={18} />
            Account settings
          </a>
          <div className="user-summary">
            <span className="avatar">
              {userFullName(session.user)
                .split(' ')
                .map((s) => s[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div>
              <strong>{userFullName(session.user)}</strong>
              <small>
                {session.user.platformOwner
                  ? 'Platform owner'
                  : view
                    ? title(view.role)
                    : 'Team member'}
              </small>
            </div>
            <button aria-label="Sign out" onClick={() => void perform(logout)}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumbs">
            <span>{view?.dsp.name ?? 'Platform'}</span>
            <span>/</span>
            <strong>{page === 'dsps' ? 'DSPs' : title(page)}</strong>
          </div>
          <div className="topbar-right">
            {(session.development || (session.standalone && session.environment === 'preview')) && (
              <span className="dev-label">
                <FlaskConical size={14} />
                {session.providerMode === 'fixture'
                  ? 'Dev platform · synthetic data'
                  : 'Dev platform'}
              </span>
            )}
            <span className="avatar pale" title={userFullName(session.user)}>
              {userFullName(session.user)
                .split(' ')
                .map((s) => s[0])
                .slice(0, 2)
                .join('')}
            </span>
          </div>
        </header>
        <main className="content" key={dspId ?? 'platform'}>
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
                  <Overview
                    view={view}
                    perform={perform}
                    navigate={navigate}
                    canCollect={canCollect}
                  />
                ) : page === 'employees' ? (
                  <EmployeesPage />
                ) : page === 'timecards' ? (
                  <TimecardsPage timezone={view.dsp.timezone} />
                ) : page === 'connections' && owner ? (
                  <ConnectionsPage
                    perform={perform}
                    development={session.providerMode === 'fixture'}
                  />
                ) : page === 'jobs' ? (
                  <JobsPage platform={false} perform={perform} canCollect={canCollect} />
                ) : page === 'settings' && owner ? (
                  <DspSettings
                    view={view}
                    perform={perform}
                    reopen={reopen}
                    onSuspended={platform}
                  />
                ) : (
                  <ErrorBox message="This page is not available for your role." />
                )}
              </div>
            ) : null
          ) : page === 'account' ? (
            <>
              <Header
                title="Account settings"
                subtitle="Manage your account and sign-in details."
              />
              <Section title="Your account">
                <dl className="details">
                  <dt>First name</dt>
                  <dd>{session.user.firstName}</dd>
                  <dt>Last name</dt>
                  <dd>{session.user.lastName}</dd>
                  <dt>Email</dt>
                  <dd>{session.user.email}</dd>
                </dl>
              </Section>
              <Section title="Change password">
                <form
                  className="settings-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void perform(async () => {
                      await api('/api/auth/password', {
                        currentPassword: form.get('currentPassword'),
                        password: form.get('password'),
                      });
                      credentials('');
                      setSession(null);
                      setView(undefined);
                      window.location.hash = '';
                    }, 'Password changed. Sign in again.');
                  }}
                >
                  <label>
                    Current password
                    <input
                      name="currentPassword"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </label>
                  <label>
                    New password
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={128}
                      required
                    />
                  </label>
                  <p className="muted">Changing your password signs out all existing sessions.</p>
                  <button className="primary">Update password</button>
                </form>
              </Section>
              {session.user.platformOwner && <HealthPanel />}
            </>
          ) : session.user.platformOwner ? (
            page === 'dsps' ? (
              <DspList open={open} perform={perform} />
            ) : page === 'jobs' ? (
              <JobsPage platform perform={perform} canCollect={false} />
            ) : page === 'releases' ? (
              <ReleasesPage perform={perform} />
            ) : page === 'audit' ? (
              <AuditPage />
            ) : (
              <ErrorBox message="Page not found." />
            )
          ) : (
            <>
              <Header title="Your DSPs" subtitle="Choose a workspace to continue." />
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
        </main>
        <footer className="main-footer">
          <span>Dispatch</span>
          <span>
            {session.environment === 'preview' || session.development
              ? 'Dev platform'
              : 'Connected workspace'}
          </span>
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
