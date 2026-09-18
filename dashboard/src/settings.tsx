import { useState } from 'react';
import { displayTimezone, saveTimezone } from './preferences.js';
import type { DspView, SessionView, AuditEvent } from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import { Header, Tabs, ErrorBox, time } from './ui.js';
import { ConnectionsPage } from './dsp.js';
import { type Perform } from './platform.js';
import { ThemeSection } from './theme.js';

export function SettingsPage({
  session,
  view,
  perform,
}: {
  session: SessionView;
  view?: DspView;
  perform: Perform;
}) {
  const [requestedTab, setTab] = useState(
    new URLSearchParams(location.hash.split('?')[1]).get('tab') || 'general',
  );
  const [timezone, setTimezone] = useState(() => displayTimezone() ?? '');
  const timezones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = view?.role === 'owner' || view?.role === 'platform_owner';
  const tabs = [
    ['general', 'General'],
    ['security', 'Security'],
    ...(owner ? [['connections', 'Connections']] : []),
    ['theme', 'Theme'],
    ...(owner ? [['audit', 'Audit log']] : []),
  ];
  const tab = tabs.some(([id]) => id === requestedTab) ? requestedTab : 'general';
  return (
    <>
      <Header title="Settings" />
      <Tabs
        value={tab}
        onChange={(value) => {
          setTab(value);
          history.replaceState(
            {},
            '',
            `${location.pathname}${location.search}${location.hash.split('?')[0]}?tab=${value}`,
          );
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
                  {session.user.platformOwner ? 'Platform owner' : (view?.role ?? 'Team member')}
                </dd>
              </div>
            </dl>
          </section>
          <section className="settings-section">
            <div>
              <h2>Date &amp; time</h2>
            </div>
            <div className="theme-pack-field">
              <label htmlFor="display-timezone">Display timezone</label>
              <select
                id="display-timezone"
                value={timezone}
                onChange={(event) => {
                  setTimezone(event.target.value);
                  saveTimezone(event.target.value);
                }}
              >
                <option value="">
                  Automatic — device timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                </option>
                {timezones.map((zone) => (
                  <option value={zone} key={zone}>
                    {zone.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
              <p>
                Calendar dates, sync and activity times use{' '}
                {timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}. Paycom punches keep
                the DSP’s business time; Flex times keep the station’s timezone.
              </p>
              <p>Saved for your account on this browser.</p>
            </div>
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
              setBusy(true);
              void perform(async () => {
                await api('/api/auth/password', {
                  currentPassword: form.get('currentPassword'),
                  password: form.get('password'),
                });
                location.hash = 'signin';
                location.reload();
              }).finally(() => setBusy(false));
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
                minLength={12}
                maxLength={128}
                required
                disabled={busy}
              />
            </label>
            <p className="muted">Use at least 12 characters.</p>
            <label>
              Confirm new password
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
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
      {tab === 'connections' && owner && (
        <div className="settings-connections">
          <ConnectionsPage perform={perform} development={session.providerMode === 'fixture'} />
        </div>
      )}
      {tab === 'theme' && <ThemeSection userId={session.user.id} />}
      {tab === 'audit' && <SettingsAudit view={view} />}
    </>
  );
}

function SettingsAudit({ view }: { view?: DspView }) {
  const { data, error } = useData<AuditEvent[]>(
    view ? '/api/dsp/audit' : '/api/platform/audit',
    10000,
  );
  return (
    <>
      <ErrorBox message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Actor</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((event) => (
              <tr key={event.id}>
                <td>{event.action.replaceAll('.', ' ')}</td>
                <td>{event.actorName}</td>
                <td>{time(event.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data?.length === 0 && <p className="muted">No activity yet.</p>}
    </>
  );
}
