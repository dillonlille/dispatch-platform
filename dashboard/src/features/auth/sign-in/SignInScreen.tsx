import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { SignInLayout } from './SignInLayout.js';
import { SignInPasswordField } from './SignInPasswordField.js';
import { api } from '../../../app/api.js';
import { ErrorBox } from '../../../ui/index.js';
import { messageOf } from '../../../lib/errors.js';
import { hashQuery, navigate, platformHash, signInHash } from '../../../app/navigation.js';
import { clearSignInHandoff, getSignInHandoff } from '../../../app/sign-in-handoff.js';
export function SignInScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  const [handoff] = useState(getSignInHandoff);
  useEffect(clearSignInHandoff, []);
  const hash = window.location.hash.slice(1),
    token = hashQuery().get('token');
  const initial = hash.startsWith('reset?') ? 'reset' : 'login';
  const [mode, setMode] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    const form = new FormData(event.currentTarget),
      email = String(form.get('email') ?? ''),
      password = String(form.get('password') ?? '');
    if (mode === 'reset' && password !== form.get('confirmPassword')) {
      setError('The passwords must match.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await api('/api/auth/login', {
          email,
          password,
          rememberMe: form.get('rememberMe') === 'on',
        });
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
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  const heading = {
    login: 'Sign in',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  }[mode];
  return (
    <SignInLayout enter={handoff?.animate}>
      <section className="auth-panel" aria-labelledby="auth-title">
        <h1 id="auth-title">{heading}</h1>
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
                placeholder="you@example.test"
                defaultValue={handoff?.email}
                required
              />
            </label>
          )}
          {mode !== 'forgot' && (
            <SignInPasswordField
              key={mode}
              current={mode === 'login'}
              autoFocus={Boolean(handoff) && mode === 'login'}
              action={
                mode === 'login' ? (
                  <button
                    type="button"
                    className="auth-forgot"
                    onClick={() => {
                      setMode('forgot');
                      setError('');
                      setNotice('');
                    }}
                  >
                    Forgot password?
                  </button>
                ) : undefined
              }
            />
          )}
          {mode === 'reset' && (
            <SignInPasswordField name="confirmPassword" label="Confirm password" />
          )}
          {mode === 'login' && (
            <label className="auth-remember">
              <input name="rememberMe" type="checkbox" />
              Remember Me
            </label>
          )}
          <button className="primary full auth-submit" disabled={busy}>
            <span>
              {busy
                ? 'Please wait…'
                : mode === 'login'
                  ? 'Sign in'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : 'Update password'}
            </span>
            <ArrowRight size={20} aria-hidden="true" />
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
        <p className="auth-footer">Access is by invitation.</p>
      </section>
    </SignInLayout>
  );
}
