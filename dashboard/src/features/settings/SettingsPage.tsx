import { useState } from 'react';
import type { DspView, SessionView } from '../../../../shared/contracts/index.js';
import { api } from '../../app/api.js';
import { Badge, DetailList, ErrorBox, Header, Tabs } from '../../ui/index.js';
import { timezoneName } from '../../lib/format.js';
import { can } from '../../app/permissions.js';
import { AuditLog } from '../audit/index.js';
import { ConnectionsPage } from '../connections/index.js';
import { useAction } from '../../app/useAction.js';
import { ThemeSection } from './ThemeSection.js';
import { hashQuery, navigate, replaceHashQuery, signInHash } from '../../app/navigation.js';
import { SupportVisibility } from './SupportVisibility.js';

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
  const role = session.user.platformOwner ? 'Platform owner' : (view?.role.name ?? 'Team member');
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
          <div className="settings-identity">
            <span className="avatar">
              {session.user.firstName[0]}
              {session.user.lastName[0]}
            </span>
            <div>
              <strong>
                {session.user.firstName} {session.user.lastName}
                <span className="role-badge">{role}</span>
              </strong>
              <small>{session.user.email}</small>
            </div>
          </div>
          <section className="settings-section">
            <div>
              <h2>Account</h2>
            </div>
            <DetailList
              className="field-grid"
              items={[
                ['First name', session.user.firstName],
                ['Last name', session.user.lastName],
                ['Email address', session.user.email],
                ['Role', role],
              ]}
            />
          </section>
          {view && (
            <section className="settings-section">
              <div>
                <h2>Workspace</h2>
              </div>
              <DetailList
                className="field-grid"
                items={[
                  ['DSP', view.dsp.name],
                  ['Station', view.profile?.stationCode || '—'],
                  [
                    'Business timezone',
                    <>
                      {timezoneName(view.dsp.timezone)} <small>{view.dsp.timezone}</small>
                    </>,
                  ],
                  ['Status', <Badge value={view.dsp.status} />],
                ]}
              />
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
