import { useState } from 'react';
import type { DspSummary, DspView, SessionView } from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import { Header, Tabs, ErrorBox, Loading, Empty, can } from './ui.js';
import { AuditLog } from './audit.js';
import { ConnectionsPage } from './dsp.js';
import { useAction } from './lib/useAction.js';
import { ThemeSection } from './theme.js';
import { hashQuery, navigate, replaceHashQuery, signInHash } from './app/navigation.js';

export function SettingsPage({ session, view }: { session: SessionView; view?: DspView }) {
  const [requestedTab, setTab] = useState(hashQuery().get('tab') || 'general');
  const [passwordError, setPasswordError] = useState('');
  const changePassword = useAction(async (form: FormData) => {
    await api('/api/auth/password', {
      currentPassword: form.get('currentPassword'),
      password: form.get('password'),
    });
    navigate(signInHash);
    location.reload();
  });
  const busy = changePassword.busy;
  const connections = can(view, 'connections.manage');
  const tabs = [
    ['general', 'General'],
    ['security', 'Security'],
    ...(connections ? [['connections', 'Connections']] : []),
    ['theme', 'Theme'],
    ...(can(view, 'audit.view') ? [['audit', 'Audit log']] : []),
    ...(!view && session.user.platformOwner ? [['support', 'Platform support']] : []),
  ];
  const tab = tabs.some(([id]) => id === requestedTab) ? requestedTab : 'general';
  return (
    <>
      <Header title="Settings" />
      <Tabs
        value={tab}
        onChange={(value) => {
          setTab(value);
          replaceHashQuery({ tab: value });
        }}
        items={tabs}
        label="Settings"
      />
      {tab === 'general' && (
        <>
          <section className="settings-section">
            <div>
              <h2>Account</h2>
            </div>
            <dl className="detail-list">
              <div>
                <dt>First name</dt>
                <dd>{session.user.firstName}</dd>
              </div>
              <div>
                <dt>Last name</dt>
                <dd>{session.user.lastName}</dd>
              </div>
              <div>
                <dt>Email address</dt>
                <dd>{session.user.email}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>
                  {session.user.platformOwner
                    ? 'Platform owner'
                    : (view?.role.name ?? 'Team member')}
                </dd>
              </div>
            </dl>
          </section>
          {view && (
            <section className="settings-section">
              <div>
                <h2>Workspace</h2>
              </div>
              <dl className="detail-list">
                <div>
                  <dt>DSP</dt>
                  <dd>{view.dsp.name}</dd>
                </div>
                <div>
                  <dt>Station</dt>
                  <dd>{view.profile?.stationCode || '—'}</dd>
                </div>
                <div>
                  <dt>Business timezone</dt>
                  <dd>{view.dsp.timezone}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{view.dsp.status}</dd>
                </div>
              </dl>
            </section>
          )}
        </>
      )}
      {tab === 'security' && (
        <section className="settings-section">
          <div>
            <h2>Change password</h2>
            <p>Changing your password signs out all sessions.</p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setPasswordError('');
              if (form.get('password') !== form.get('confirmPassword')) {
                setPasswordError('The new passwords must match.');
                return;
              }
              void changePassword.run(form);
            }}
          >
            <label>
              Current password
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                required
                disabled={busy}
              />
            </label>
            <label>
              New password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
                disabled={busy}
              />
            </label>
            <p className="muted">Use at least 8 characters.</p>
            <label>
              Confirm new password
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
                disabled={busy}
              />
            </label>
            <ErrorBox message={passwordError} />
            <button className="primary" disabled={busy}>
              {busy ? 'Changing password…' : 'Change password'}
            </button>
          </form>
        </section>
      )}
      {tab === 'connections' && connections && view && (
        <div className="settings-connections">
          <ConnectionsPage
            development={session.providerMode === 'fixture'}
            timezone={view.dsp.timezone}
          />
        </div>
      )}
      {tab === 'theme' && <ThemeSection userId={session.user.id} />}
      {tab === 'audit' && view && <AuditLog view={view} />}
      {tab === 'support' && <SupportVisibility />}
    </>
  );
}

// Where it is on, a platform owner's activity is listed in that DSP's audit log,
// always as "Platform support". It applies from the moment it is switched.
function SupportVisibility() {
  const { data, error, refresh } = useData<DspSummary[]>('/api/platform/dsps');
  const dsps = data?.filter((dsp) => !dsp.profile.removed);
  // The switch moves at once; a refused change puts it back.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const show = useAction(
    (dsp: DspSummary, visible: boolean) =>
      api(`/api/platform/dsps/${dsp.id}/support-visibility`, { visible }),
    {
      success: (dsp, visible) =>
        visible
          ? `Platform support shown to ${dsp.name}`
          : `Platform support hidden from ${dsp.name}`,
    },
  );
  return (
    <section className="settings-section">
      <div>
        <h2>Show Platform support in audit logs</h2>
      </div>
      <ErrorBox message={error} />
      {!dsps ? (
        !error && <Loading />
      ) : !dsps.length ? (
        <Empty title="No DSPs" />
      ) : (
        <div className="permission-rows support-visibility">
          {dsps.map((dsp) => (
            <label className="permission-row" key={dsp.id}>
              <span>{dsp.name}</span>
              <input
                type="checkbox"
                role="switch"
                checked={chosen[dsp.id] ?? dsp.profile.supportVisible}
                onChange={(event) => {
                  const visible = event.target.checked;
                  setChosen((current) => ({ ...current, [dsp.id]: visible }));
                  void show.run(dsp, visible).then((saved) => {
                    if (!saved) setChosen((current) => ({ ...current, [dsp.id]: !visible }));
                    refresh();
                  });
                }}
              />
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
