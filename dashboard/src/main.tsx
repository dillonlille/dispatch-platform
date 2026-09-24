import { useBrowserUpdate, clearNavigationState } from './app/browser-update.js';
import { lazy, Suspense, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type { DspView, SessionView } from '../../shared/contracts/index.js';
import { api, credentials, ApiError } from './app/api.js';
import { FeedbackMessages, FeedbackProvider, useFeedback } from './app/feedback.js';
import {
  dspHash,
  navigate,
  parseHash,
  platformHash,
  rememberDestination,
} from './app/navigation.js';
import { Page, findRoute, navigation } from './app/routes.js';
import type { DspRouteId } from './app/route-meta.js';
import { routeLabel } from './app/route-meta.js';
const AuthScreen = lazy(() =>
  import('./features/auth/index.js').then((module) => ({ default: module.AuthScreen })),
);
const DspOnboarding = lazy(() =>
  import('./features/auth/index.js').then((module) => ({ default: module.DspOnboarding })),
);
import { messageOf } from './lib/errors.js';
import { Loading, PageBoundary } from './ui/index.js';
import { can } from './app/permissions.js';
import './styles.css';
import { Shell } from './shell/Shell.js';
type Session = SessionView;
import { restoreAppearance } from './app/appearance.js';
import { leavePresence, usePresence } from './app/presence.js';
import { openView, saveRole } from './app/session.js';
import { getSession } from './app/endpoints.js';
function App() {
  const [session, setSession] = useState<Session | null>(),
    [view, setView] = useState<DspView>(),
    [address, setAddress] = useState(() => parseHash(window.location.hash)),
    [switching, setSwitching] = useState(false),
    [sessionError, setSessionError] = useState(''),
    [online, setOnline] = useState(navigator.onLine);
  const { perform, fail } = useFeedback();
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const setupRequired = Boolean(view?.profile?.setupRequired && can(view, 'settings.manage'));
  const showAuth =
    session === null ||
    address.route === 'signin' ||
    address.route.startsWith('invite?') ||
    address.route.startsWith('reset?');
  const onboarding = address.route.startsWith('invite?') || (!showAuth && setupRequired);
  useLayoutEffect(() => {
    const apply = () => restoreAppearance(session?.user.id, onboarding ? 'light' : undefined);
    const media = matchMedia('(prefers-color-scheme: dark)');
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('dispatch-appearance', apply);
    return () => {
      media.removeEventListener('change', apply);
      window.removeEventListener('dispatch-appearance', apply);
    };
  }, [session?.user.id, onboarding]);
  const load = useCallback(
    async (afterLogin = false) => {
      setSessionError('');
      try {
        const next = await getSession();
        credentials(next.csrf);
        setSession(next);
        if (
          !next.user.platformOwner &&
          (afterLogin || !/^#(?:invite\?|reset\?|signin)/.test(window.location.hash)) &&
          !window.location.hash.startsWith('#dsp/') &&
          next.dsps.length === 1
        )
          navigate(dspHash(next.dsps[0]!.id));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          credentials('');
          setSession(null);
        } else {
          setSessionError(messageOf(error));
          fail(messageOf(error));
        }
      }
    },
    [fail],
  );
  useEffect(() => {
    void load();
    const changed = () => {
      setAddress(parseHash(window.location.hash));
      fail('');
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [load, fail]);
  const { route, dspId, page } = address;
  useEffect(() => {
    if (session && !showAuth)
      void findRoute(dspId ? 'dsp' : 'platform', page)
        ?.preload()
        .catch(() => undefined);
  }, [session, showAuth, dspId, page]);
  useEffect(() => {
    if (
      view &&
      dspId &&
      navigation('dsp', { session: session!, view }).some((route) => route.id === page)
    )
      rememberDestination(dspId, page as DspRouteId);
  }, [view, dspId, page, session]);
  useBrowserUpdate(Boolean(session) && (!dspId || Boolean(view)) && !switching);
  // A platform owner looking into a DSP is never shown to its team.
  usePresence(session?.user.platformOwner ? undefined : view?.token);
  const reopen = useCallback(async () => {
    if (!session || !dspId) return;
    const next = await openView(session, dspId);
    if (parseHash(window.location.hash).dspId !== dspId) return;
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
    if (!dspId) saveRole();
    if (!session) return;
    credentials(session.csrf);
    if (!dspId) return;
    let active = true;
    setSwitching(true);
    void openView(session, dspId)
      .then((next) => {
        if (active) {
          credentials(session.csrf, next.token);
          setView(next);
        }
      })
      .catch((error) => {
        if (active) fail(messageOf(error));
      })
      .finally(() => {
        if (active) setSwitching(false);
      });
    return () => {
      active = false;
    };
  }, [session, dspId, fail]);
  if (session === undefined)
    return (
      <>
        {sessionError ? <button onClick={() => void load()}>Retry connection</button> : <Loading />}
        <FeedbackMessages />
      </>
    );
  if (showAuth) return <AuthScreen key={route} onLogin={() => load(true)} />;
  if (setupRequired)
    return (
      <DspOnboarding
        complete={async () => {
          await load();
          await reopen();
        }}
        signOut={logout}
      />
    );
  const scope = dspId ? 'dsp' : 'platform';
  async function logout() {
    await leavePresence();
    await api('/api/auth/logout', {});
    credentials('');
    setSession(null);
    setView(undefined);
    navigate('');
  }
  return (
    <Shell
      session={session}
      view={view}
      dspId={dspId}
      page={page}
      current={findRoute(scope, page)?.parent ?? page}
      label={routeLabel(scope, page)}
      navigation={navigation(scope, { session, view })}
      logout={() => void perform(logout)}
      exitView={() => navigate(platformHash())}
      viewAs={(roleId) => {
        clearNavigationState();
        saveRole(dspId, roleId);
        void perform(reopen);
      }}
    >
      <FeedbackMessages />
      {!online && (
        <p role="status">
          You’re offline. Showing the last loaded data; updates resume when you reconnect.
        </p>
      )}
      {dspId ? (
        switching ? (
          <Loading />
        ) : view ? (
          <div key={`${view.dsp.id}:${view.dsp.revision}:${view.role.id}`}>
            <Page session={session} view={view} page={page} reopen={reopen} />
          </div>
        ) : (
          <button onClick={() => void perform(reopen)}>Retry connection</button>
        )
      ) : (
        <Page session={session} page={page} reopen={reopen} />
      )}
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(
  <FeedbackProvider>
    <PageBoundary>
      <Suspense fallback={<Loading />}>
        <App />
      </Suspense>
    </PageBoundary>
  </FeedbackProvider>,
);
