import { useState } from 'react';
import { api } from '../../app/api.js';
import { usePasskeys, useAccountSessions } from '../../app/endpoints.js';
import { registerPasskey, verifyIfNeeded } from '../../app/passkeys.js';
import { useAction } from '../../app/useAction.js';
import { ConfirmDialog, DataState, ErrorBox } from '../../ui/index.js';
import { RecoveryCodes } from '../../ui/RecoveryCodes.js';

export function SecuritySettings() {
  const keys = usePasskeys();
  const sessions = useAccountSessions();
  const [codes, setCodes] = useState<string[]>([]);
  const [removing, setRemoving] = useState<{ id: string; last: boolean }>();
  const action = useAction(
    async (work: () => Promise<void>) => {
      await work();
      keys.refresh();
      sessions.refresh();
    },
    { inline: true },
  );
  const run = (work: () => Promise<void>) => void action.run(work);
  return (
    <div className="security-settings">
      <ErrorBox message={action.error} />
      {removing && (
        <ConfirmDialog
          title={removing.last ? 'Turn off passkey protection?' : 'Remove passkey?'}
          confirm={removing.last ? 'Turn off' : 'Remove'}
          busy={action.busy}
          onCancel={() => setRemoving(undefined)}
          onConfirm={() =>
            run(async () => {
              await verifyIfNeeded();
              await api(`/api/auth/security/passkeys/${removing.id}/remove`, {});
              setRemoving(undefined);
              window.dispatchEvent(new Event('dispatch-security-changed'));
            })
          }
        >
          {removing.last
            ? 'Your account will use email and password only. Recovery codes will be invalidated and other sessions signed out.'
            : 'Other sessions will be signed out. Your remaining passkeys will still work.'}
        </ConfirmDialog>
      )}
      {codes.length > 0 && <RecoveryCodes codes={codes} done={() => setCodes([])} />}
      <section className="security-section">
        <h2>Passkeys</h2>
        <DataState data={keys.data} error={keys.error}>
          {(items) => (
            <>
              {items.map((key) => (
                <div className="security-row" key={key.id}>
                  <div>
                    <span>{key.name}</span>
                    <small>Added {new Date(key.createdAt).toLocaleDateString()}</small>
                  </div>
                  <button
                    disabled={action.busy}
                    onClick={() => setRemoving({ id: key.id, last: items.length === 1 })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = String(new FormData(event.currentTarget).get('name'));
                  run(async () => {
                    await verifyIfNeeded();
                    setCodes(await registerPasskey(name));
                    window.dispatchEvent(new Event('dispatch-security-changed'));
                  });
                }}
              >
                {!items.length && (
                  <p className="muted">
                    Optional. Adding a passkey turns on two-step sign-in for your account only.
                  </p>
                )}
                <label>
                  Passkey name
                  <input
                    name="name"
                    required
                    maxLength={60}
                    placeholder="My security key"
                    disabled={action.busy}
                  />
                </label>
                <button className="primary" disabled={action.busy}>
                  Add passkey
                </button>
              </form>
              {items.length > 0 && (
                <div className="security-row">
                  <h2>Recovery codes</h2>
                  <button
                    disabled={action.busy}
                    onClick={() =>
                      run(async () => {
                        await verifyIfNeeded();
                        const result = await api<{ codes: string[] }>(
                          '/api/auth/security/recovery-codes',
                          {},
                        );
                        setCodes(result.codes);
                      })
                    }
                  >
                    Replace recovery codes
                  </button>
                </div>
              )}
            </>
          )}
        </DataState>
      </section>
      <section className="security-section">
        <div className="security-row">
          <h2>Sessions</h2>
          <button
            disabled={action.busy}
            onClick={() =>
              run(async () => {
                await api('/api/auth/security/sessions/revoke-others', {});
              })
            }
          >
            Sign out other sessions
          </button>
        </div>
        <DataState data={sessions.data} error={sessions.error}>
          {(items) =>
            items.map((session) => (
              <div className="security-row" key={session.id}>
                <div>
                  {session.current ? 'This session' : 'Other session'}
                  <small>Signed in {new Date(session.createdAt).toLocaleString()}</small>
                </div>
                {session.current ? (
                  <span>Current</span>
                ) : (
                  <button
                    disabled={action.busy}
                    onClick={() =>
                      run(async () => {
                        await api(`/api/auth/security/sessions/${session.id}/revoke`, {});
                      })
                    }
                  >
                    Sign out
                  </button>
                )}
              </div>
            ))
          }
        </DataState>
        <button
          disabled={action.busy}
          onClick={() =>
            run(async () => {
              await api('/api/auth/security/sessions/revoke-all', {});
              window.dispatchEvent(new Event('dispatch-signed-out'));
            })
          }
        >
          Sign out all sessions
        </button>
      </section>
    </div>
  );
}
