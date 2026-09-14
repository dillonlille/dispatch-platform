import { useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Brand } from './brand.js';
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
        setNotice('If that account exists, a reset link has been requested.');
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
    login: 'Sign in to Dispatch',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
    invite: 'Join your team',
  }[mode];
  return (
    <main className="auth-layout">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-panel">
        <h1>{heading}</h1>
        <p className="auth-description">
          {mode === 'login'
            ? 'Welcome back. Sign in to your workspace.'
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
              <input name="email" type="email" autoComplete="email" required />
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
              />
            </label>
          )}
          {mode === 'login' && (
            <button
              type="button"
              className="auth-forgot"
              onClick={() => {
                setMode('forgot');
                setError('');
              }}
            >
              Forgot password?
            </button>
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
        {mode !== 'login' && (
          <button
            className="text-button auth-back"
            onClick={() => {
              setMode('login');
              setError('');
              setNotice('');
            }}
          >
            <ArrowLeft size={15} />
            Back to sign in
          </button>
        )}
      </section>
      <p className="auth-footer">Access is by invitation.</p>
    </main>
  );
}
