import { useState } from 'react';
import type { SecurityStatus } from '../../../../shared/contracts/index.js';
import { api, ApiError } from '../../app/api.js';
import { verifyPasskey } from '../../app/passkeys.js';
import { useAction } from '../../app/useAction.js';
import { ErrorBox } from '../../ui/index.js';
import '../settings/security.css';

type Method = 'passkey' | 'authenticator' | 'recovery' | 'password';

/** Verification only. Enrollment and removal live exclusively in account settings. */
export function SecurityPrompt({
  security,
  complete,
  signOut,
}: {
  security: SecurityStatus;
  complete: () => Promise<void>;
  signOut: () => Promise<void>;
}) {
  const initial: Method = security.passkeyCount
    ? 'passkey'
    : security.authenticator
      ? 'authenticator'
      : 'password';
  const [method, setMethod] = useState<Method>(initial);
  const action = useAction(
    async (form: FormData) => {
      try {
        if (method === 'passkey') await verifyPasskey();
        else if (method === 'authenticator')
          await api('/api/auth/security/authenticator/verify', { code: form.get('code') });
        else if (method === 'recovery')
          await api('/api/auth/security/recover', { code: form.get('code') });
        else await api('/api/auth/security/reauthenticate', { password: form.get('password') });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'sign_in_again') setMethod('password');
        throw error;
      }
      await complete();
    },
    { inline: true },
  );
  return (
    <section className="security-prompt">
      <h1>Verify your identity</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(new FormData(event.currentTarget));
        }}
      >
        {method === 'authenticator' && (
          <label>
            6-digit code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              required
              autoFocus
            />
          </label>
        )}
        {method === 'recovery' && (
          <label>
            Recovery code
            <input name="code" autoComplete="off" required maxLength={64} autoFocus />
          </label>
        )}
        {method === 'password' && (
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              autoFocus
            />
          </label>
        )}
        <ErrorBox message={action.error} />
        <button className="primary" disabled={action.busy}>
          {action.busy
            ? 'Verifying…'
            : method === 'passkey'
              ? 'Verify with passkey'
              : method === 'authenticator'
                ? 'Verify code'
                : method === 'recovery'
                  ? 'Use recovery code'
                  : 'Verify password'}
        </button>
      </form>
      {security.passkeyCount > 0 && method !== 'passkey' && (
        <button
          className="security-quiet"
          disabled={action.busy}
          onClick={() => setMethod('passkey')}
        >
          Use a passkey
        </button>
      )}
      {security.authenticator && method !== 'authenticator' && (
        <button
          className="security-quiet"
          disabled={action.busy}
          onClick={() => setMethod('authenticator')}
        >
          Use an authenticator app
        </button>
      )}
      {security.enrolled && method !== 'recovery' && (
        <button
          className="security-quiet"
          disabled={action.busy}
          onClick={() => setMethod('recovery')}
        >
          Use a recovery code
        </button>
      )}
      <button className="security-quiet" disabled={action.busy} onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}
