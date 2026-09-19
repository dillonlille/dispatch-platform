import { useBrowserUpdate } from './browser-update.js';
import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import type { DspView, SessionView } from '../../shared/contracts/index.js';
import { api, credentials, ApiError } from './api.js';
import { FeedbackMessages, FeedbackProvider, useFeedback } from './app/feedback.js';
import { dspHash, navigate, parseHash, platformHash } from './app/navigation.js';
import { Page, findRoute, navigation, routeLabel } from './app/routes.js';
import { AuthScreen } from './auth.js';
import { messageOf } from './lib/errors.js';
import { Loading, can } from './ui.js';
import './styles.css';
import { DspOnboarding } from './onboarding.js';
import { Shell } from './shell.js';
type Session = SessionView;
import { readAppearance, applyAppearance } from './appearance.js';
import { leavePresence, usePresence } from './presence.js';
// The role a platform owner looks through survives a reload of this tab and is
// forgotten once they leave the DSP.
const VIEW_ROLE = 'dispatch-view-role';
let viewRole: string | null | undefined;
function savedRole(dspId: string) {
  if (viewRole === undefined)
    try {
      viewRole = sessionStorage.getItem(VIEW_ROLE);
    } catch {
      viewRole = null;
    }
  const [dsp, role] = viewRole?.split(' ') ?? [];
  return dsp === dspId ? role : undefined;
}
function saveRole(dspId?: string, roleId?: string) {
  viewRole = dspId && roleId ? `${dspId} ${roleId}` : null;
  try {
    if (viewRole) sessionStorage.setItem(VIEW_ROLE, viewRole);
    else sessionStorage.removeItem(VIEW_ROLE);
  } catch {
    /* The role still applies until the page reloads. */
  }
}
async function openView(session: Session, dspId: string) {
  const roleId = session.user.platformOwner ? savedRole(dspId) : undefined;
  if (!roleId) return api<DspView>('/api/session/dsp', { dspId });
  try {
    return await api<DspView>('/api/session/dsp', { dspId, roleId });
  } catch (error) {
    // The DSP deleted the role being looked through; owner access remains.
    if (!(error instanceof ApiError) || error.code !== 'dsp_view_expired') throw error;
    saveRole();
    return api<DspView>('/api/session/dsp', { dspId });
  }
}
function App() {
  const [session, setSession] = useState<Session | null>(),
    [view, setView] = useState<DspView>(),
    [address, setAddress] = useState(() => parseHash(window.location.hash)),
    [switching, setSwitching] = useState(false);
  const { perform, fail } = useFeedback();
  useEffect(() => {
    const id = session?.user.id ?? 'signed-out';
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
  const load = useCallback(
    async (afterLogin = false) => {
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
          navigate(dspHash(next.dsps[0]!.id));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          credentials('');
          setSession(null);
        } else fail(messageOf(error));
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
        <Loading />
        <FeedbackMessages />
      </>
    );
  if (
    session === null ||
    route === 'signin' ||
    route.startsWith('invite?') ||
    route.startsWith('reset?')
  )
    return <AuthScreen onLogin={() => load(true)} />;
  if (view?.profile?.setupRequired && can(view, 'settings.manage'))
    return <DspOnboarding complete={reopen} />;
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
        saveRole(dspId, roleId);
        void perform(reopen);
      }}
    >
      <FeedbackMessages />
      {dspId ? (
        switching ? (
          <Loading />
        ) : view ? (
          <div key={`${view.dsp.id}:${view.dsp.revision}:${view.role.id}`}>
            <Page session={session} view={view} page={page} reopen={reopen} />
          </div>
        ) : null
      ) : (
        <Page session={session} page={page} reopen={reopen} />
      )}
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(
  <FeedbackProvider>
    <App />
  </FeedbackProvider>,
);
