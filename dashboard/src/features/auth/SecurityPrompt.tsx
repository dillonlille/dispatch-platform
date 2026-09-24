import { useState } from 'react';
import { api, ApiError } from '../../app/api.js';
import { verifyPasskey } from '../../app/passkeys.js';
import { useAction } from '../../app/useAction.js';
import { ErrorBox } from '../../ui/index.js';
import '../settings/security.css';

/** Verification only. Enrollment and removal live exclusively in account settings. */
export function SecurityPrompt({
  enrolled,
  complete,
  signOut,
}: {
  enrolled: boolean;
  complete: () => Promise<void>;
  signOut: () => Promise<void>;
}) {
  const [recovery, setRecovery] = useState(false);
  const [passwordCheck, setPasswordCheck] = useState(false);
  const action = useAction(
    async (form: FormData) => {
      if (!enrolled || passwordCheck) {
        await api('/api/auth/security/reauthenticate', { password: form.get('password') });
        if (enrolled) {
          setPasswordCheck(false);
          return;
        }
      } else {
        try {
          if (recovery) await api('/api/auth/security/recover', { code: form.get('code') });
          else await verifyPasskey();
        } catch (error) {
          if (error instanceof ApiError && error.code === 'sign_in_again') setPasswordCheck(true);
          throw error;
        }
      }
      await complete();
    },
    { inline: true },
  );
  const password = !enrolled || passwordCheck;
  return (
    <section className="security-prompt">
      <h1>Verify your identity</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(new FormData(event.currentTarget));
        }}
      >
        {password ? (
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
        ) : recovery ? (
          <label>
            Recovery code
            <input name="code" autoComplete="off" required minLength={43} maxLength={43} />
          </label>
        ) : null}
        <ErrorBox message={action.error} />
        <button className="primary" disabled={action.busy}>
          {action.busy
            ? 'Verifying…'
            : password
              ? 'Verify password'
              : recovery
                ? 'Use recovery code'
                : 'Verify with passkey'}
        </button>
      </form>
      {enrolled && !password && (
        <button className="quiet" disabled={action.busy} onClick={() => setRecovery(!recovery)}>
          {recovery ? 'Use a passkey' : 'Use a recovery code'}
        </button>
      )}
      <button className="quiet" disabled={action.busy} onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}
