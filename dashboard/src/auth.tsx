import { useState, type FormEvent } from 'react';
import { Layers3, ArrowLeft } from 'lucide-react';
import { api } from './api.js';
import { ErrorBox } from './ui.js';
export function AuthScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  const hash = window.location.hash.slice(1),
    token = new URLSearchParams(hash.split('?')[1]).get('token');
  const initial = hash.startsWith('reset?')
    ? 'reset'
    : hash.startsWith('invite?')
      ? 'invite'
      : 'login';
  const [mode, setMode] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const form = new FormData(event.currentTarget),
      email = String(form.get('email') ?? ''),
      password = String(form.get('password') ?? '');
    try {
      if (mode === 'login') {
        await api('/api/auth/login', { email, password });
        await onLogin();
        if (!window.location.hash.startsWith('#dsp/')) window.location.hash = 'dsps';
      }
      if (mode === 'forgot') {
        await api('/api/auth/forgot-password', { email });
        setNotice(
          'If that account exists, a reset link is on its way. In development, check the private development-mail directory.',
        );
      }
      if (mode === 'reset') {
        await api('/api/auth/reset-password', { token, password });
        window.location.hash = 'signin';
        setMode('login');
        setNotice('Password updated. Sign in with your new password.');
      }
      if (mode === 'invite') {
        await api(`/api/invitations/${token}/accept`, {
          firstName: String(form.get('firstName')),
          lastName: String(form.get('lastName')),
          password,
        });
        window.location.hash = 'signin';
        setMode('login');
        setNotice('Invitation accepted. Sign in with your invited email address.');
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const heading = {
    login: 'Welcome back',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
    invite: 'Join your team',
  }[mode];
  return (
    <main className="auth-layout">
      <aside className="auth-brand">
        <a className="brand" href="/">
          <Layers3 />
          Dispatch
        </a>
        <div>
          <span className="eyebrow">A CLEARER VIEW OF YOUR OPERATIONS</span>
          <h1>
            One place.
            <br />
            Every DSP.
          </h1>
          <p>Your team, connections, and daily operations — together in Dispatch.</p>
        </div>
        <span className="auth-foot">Built for the work ahead.</span>
      </aside>
      <div className="auth-main">
        <div className="auth-card">
          <span className="eyebrow">DISPATCH PLATFORM</span>
          <h1>{heading}</h1>
          <p>
            {mode === 'login'
              ? 'Sign in to access your DSP workspace.'
              : mode === 'invite'
                ? 'Use a new password, or your current password if you already have a Dispatch account.'
                : 'We’ll help you get back to your workspace.'}
          </p>
          <ErrorBox message={error} />
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          <form onSubmit={(event) => void submit(event)}>
            {(mode === 'login' || mode === 'forgot') && (
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@company.com"
                />
              </label>
            )}
            {mode === 'invite' && (
              <>
                <label>
                  First name
                  <input name="firstName" autoComplete="given-name" required maxLength={100} />
                </label>
                <label>
                  Last name
                  <input name="lastName" autoComplete="family-name" required maxLength={100} />
                </label>
              </>
            )}
            {mode !== 'forgot' && (
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  minLength={mode === 'login' ? 1 : 12}
                  maxLength={128}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  placeholder={mode === 'login' ? 'Enter your password' : 'At least 12 characters'}
                />
              </label>
            )}
            <button className="primary full" disabled={busy}>
              {busy
                ? 'Please wait…'
                : mode === 'login'
                  ? 'Sign in'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : mode === 'invite'
                      ? 'Accept invitation'
                      : 'Update password'}
            </button>
          </form>
          {mode === 'login' ? (
            <button
              className="text-button auth-link"
              onClick={() => {
                setMode('forgot');
                setError('');
              }}
            >
              Forgot password?
            </button>
          ) : (
            <button
              className="text-button auth-link"
              onClick={() => {
                window.location.hash = '';
                setMode('login');
                setError('');
              }}
            >
              <ArrowLeft size={15} />
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
