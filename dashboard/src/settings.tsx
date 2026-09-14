import { useState } from 'react';
import { displayTimezone, saveTimezone } from './preferences.js';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { DspView, SessionView, AuditEvent } from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import { Header, Tabs, ErrorBox, time } from './ui.js';
import { ConnectionsPage } from './dsp.js';
import { type Perform } from './platform.js';
import { readAppearance, saveAppearance, type Appearance } from './appearance.js';

export function SettingsPage({
  session,
  view,
  perform,
  reopen,
}: {
  session: SessionView;
  view?: DspView;
  perform: Perform;
  reopen?: () => Promise<void>;
}) {
  const [requestedTab, setTab] = useState(
    new URLSearchParams(location.hash.split('?')[1]).get('tab') || 'general',
  );
  const [mode, setMode] = useState<Appearance>(() => readAppearance(session.user.id));
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
    ...(session.user.platformOwner || owner ? [['audit', 'Audit log']] : []),
  ];
  const tab = tabs.some(([id]) => id === requestedTab) ? requestedTab : 'general';
  return (
    <>
      <Header
        title="Settings"
        subtitle={
          view ? 'Your account, workspace, and security.' : 'Your platform account and security.'
        }
      />
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
              <p>
                {view && session.user.platformOwner
                  ? 'You are signed in with your platform account.'
                  : 'Your Dispatch sign-in details.'}
              </p>
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
              <p>Choose how event times appear for you.</p>
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
                Sync and activity times use{' '}
                {timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}. Timecards keep the
                DSP’s business timezone.
              </p>
              <p>Saved for your account on this browser.</p>
            </div>
          </section>
          {view && (
            <section className="settings-section">
              <div>
                <h2>Workspace</h2>
                <p>Your current DSP context.</p>
              </div>
              {owner ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void perform(async () => {
                      await api('/api/dsp/settings', {
                        name: form.get('name'),
                        timezone: form.get('timezone'),
                      });
                      await reopen?.();
                    }, 'Workspace saved');
                  }}
                >
                  <label>
                    DSP name
                    <input name="name" defaultValue={view.dsp.name} required maxLength={100} />
                  </label>
                  <label>
                    Business timezone
                    <input name="timezone" defaultValue={view.dsp.timezone} required />
                  </label>
                  <button className="primary">Save details</button>
                </form>
              ) : (
                <dl className="detail-list">
                  <div>
                    <dt>DSP</dt>
                    <dd>{view.dsp.name}</dd>
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
              )}
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
      {tab === 'theme' && (
        <>
          <section className="settings-section">
            <div>
              <h2>Appearance</h2>
              <p>Choose how Dispatch looks on this browser.</p>
            </div>
            <div className="theme-mode-options">
              {(
                [
                  ['light', 'Light', Sun],
                  ['dark', 'Dark', Moon],
                  ['system', 'System', Monitor],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  aria-pressed={mode === value}
                  onClick={() => {
                    setMode(value);
                    saveAppearance(session.user.id, value);
                  }}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
            </div>
          </section>
          <section className="settings-section">
            <div>
              <h2>Theme</h2>
              <p>The visual style of your workspace.</p>
            </div>
            <div>
              <h3>Precision</h3>
              <p className="muted">Clear typography, quiet surfaces, and a cobalt accent.</p>
            </div>
          </section>
        </>
      )}
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
