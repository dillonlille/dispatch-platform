import { useState } from 'react';
import { Brand } from './brand.js';
import { api } from './api.js';
import { ErrorBox } from './ui.js';
export function DspOnboarding({ complete }: { complete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <main className="auth-layout">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-panel">
        <p className="muted onboarding-step">Step 2 of 2 · DSP details</p>
        <h1>Set up your DSP</h1>
        <p className="auth-description">
          Your account is ready. Add your DSP details while we prepare your workspace.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError('');
            void api('/api/dsp/profile', Object.fromEntries(form))
              .then(complete)
              .catch((error) => setError(error.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            DSP name
            <input name="name" required minLength={2} maxLength={100} disabled={busy} />
          </label>
          <label>
            Abbreviation (optional)
            <input name="abbreviation" maxLength={16} disabled={busy} />
          </label>
          <label>
            Station code
            <input
              name="stationCode"
              required
              pattern="[A-Za-z0-9]{3,8}"
              maxLength={8}
              disabled={busy}
            />
          </label>
          <label>
            Business timezone
            <input
              name="timezone"
              required
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              maxLength={80}
              disabled={busy}
            />
          </label>
          <ErrorBox message={error} />
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save DSP details'}
          </button>
        </form>
      </section>
    </main>
  );
}
