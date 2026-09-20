import { useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Brand } from '../../app/Brand.js';
import { api, useData } from '../../app/api.js';
import { OwnerOnboarding } from './OwnerOnboarding.js';
import { ErrorBox, Loading } from '../../ui/index.js';
import { messageOf } from '../../lib/errors.js';
import { dspHash, hashQuery, navigate, platformHash, signInHash } from '../../app/navigation.js';
export function AuthScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  const hash = window.location.hash.slice(1),
    token = hashQuery().get('token');
  const initial = hash.startsWith('reset?')
    ? 'reset'
    : hash.startsWith('invite?')
      ? 'invite'
      : 'login';
  const [mode, setMode] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const invitation = useData<{ email: string; onboarding: boolean }>(
    initial === 'invite' ? `/api/invitations/${encodeURIComponent(token ?? '')}` : '',
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const form = new FormData(event.currentTarget),
      email = String(form.get('email') ?? ''),
      password = String(form.get('password') ?? '');
    if ((mode === 'invite' || mode === 'reset') && password !== form.get('confirmPassword')) {
      setError('The passwords must match.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await api('/api/auth/login', { email, password });
        await onLogin();
        if (!window.location.hash.startsWith('#dsp/')) navigate(platformHash());
      }
      if (mode === 'forgot') {
        await api('/api/auth/forgot-password', { email });
        setNotice('If that account exists, a reset link has been requested.');
      }
      if (mode === 'reset') {
        await api('/api/auth/reset-password', { token, password });
        navigate(signInHash);
        setMode('login');
        setNotice('Password updated. Sign in with your new password.');
      }
      if (mode === 'invite') {
        const accepted = await api<{ email: string; dspId: string }>(
          `/api/invitations/${token}/accept`,
          {
            firstName: String(form.get('firstName')),
            lastName: String(form.get('lastName')),
            password,
          },
        );
        await api('/api/auth/login', { email: accepted.email, password });
        await onLogin();
        navigate(dspHash(accepted.dspId));
      }
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  if (mode === 'invite' && !invitation.data && !invitation.error)
    return (
      <main className="auth-layout">
        <div className="auth-brand">
          <Brand />
        </div>
        <Loading />
      </main>
    );
  if (mode === 'invite' && invitation.data?.onboarding && token)
    return (
      <OwnerOnboarding key={token} token={token} email={invitation.data.email} onLogin={onLogin} />
    );
  const heading = {
    login: 'Sign in to Dispatch',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
    invite: invitation.data?.onboarding ? 'DSP onboarding' : 'Join your team',
  }[mode];
  return (
    <main className="auth-layout">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-panel">
        <h1>{heading}</h1>

        <ErrorBox message={error || (mode === 'invite' ? invitation.error : '')} />
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
                Email address
                <input type="email" readOnly value={invitation.data?.email ?? ''} />
              </label>
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
                minLength={mode === 'login' ? 1 : 8}
                maxLength={128}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
            </label>
          )}
          {(mode === 'invite' || mode === 'reset') && (
            <label>
              Confirm password
              <input
                name="confirmPassword"
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
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
          <button
            className="primary full"
            disabled={busy || (mode === 'invite' && !invitation.data)}
          >
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
