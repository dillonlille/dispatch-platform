import { useState } from 'react';
import { Clock3 } from 'lucide-react';
import type { useAccountSessions } from '../../app/endpoints.js';
import { api } from '../../app/api.js';
import { useAction } from '../../app/useAction.js';
import { time, deviceTimezone } from '../../lib/format.js';
import { ConfirmDialog, DataState, ErrorBox } from '../../ui/index.js';

export function SessionsPanel({ sessions }: { sessions: ReturnType<typeof useAccountSessions> }) {
  const [signOutAll, setSignOutAll] = useState(false);
  const action = useAction(
    async (route: string) => {
      await api(route, {});
      sessions.refresh();
    },
    { inline: true },
  );
  const all = useAction(async () => {
    await api('/api/auth/security/sessions/revoke-all', {});
    window.dispatchEvent(new Event('dispatch-signed-out'));
  });
  return (
    <section className="security-sessions" aria-labelledby="security-sessions-title">
      <div className="security-sessions-heading">
        <h2 id="security-sessions-title">Sessions</h2>
        {sessions.data?.some((item) => !item.current) && (
          <button
            disabled={action.busy}
            onClick={() => void action.run('/api/auth/security/sessions/revoke-others')}
          >
            Sign out others
          </button>
        )}
      </div>
      <ErrorBox message={action.error} />
      <DataState data={sessions.data} error={sessions.error}>
        {(items) => (
          <div className="security-session-list">
            {items
              .toSorted((a, b) => Number(b.current) - Number(a.current))
              .map((session) => (
                <div className="security-row" key={session.id}>
                  <Clock3 size={18} aria-hidden="true" />
                  <div className="security-row-copy">
                    <span>{session.current ? 'This session' : 'Other session'}</span>
                    <small>
                      Signed in {time(new Date(session.createdAt).toISOString(), deviceTimezone())}
                    </small>
                  </div>
                  {session.current ? (
                    <span className="security-tag security-current">Current</span>
                  ) : (
                    <button
                      className="security-quiet"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(`/api/auth/security/sessions/${session.id}/revoke`)
                      }
                    >
                      Sign out
                    </button>
                  )}
                </div>
              ))}
          </div>
        )}
      </DataState>
      <div className="security-sessions-footer">
        <button className="security-quiet danger" onClick={() => setSignOutAll(true)}>
          Sign out all sessions
        </button>
      </div>
      {signOutAll && (
        <ConfirmDialog
          title="Sign out all sessions?"
          confirm="Sign out all"
          tone="danger"
          busy={all.busy}
          onCancel={() => {
            if (!all.busy) setSignOutAll(false);
          }}
          onConfirm={() => void all.run()}
        >
          This includes the session you’re using now.
        </ConfirmDialog>
      )}
    </section>
  );
}
