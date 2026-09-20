import { useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '../../../app/api.js';
import { dspHash, navigate, signInHash } from '../../../app/navigation.js';
import { useAction } from '../../../app/useAction.js';
import { ErrorBox } from '../../../ui/index.js';
import { MemberProfileLayout } from './MemberProfileLayout.js';
import { MemberProfilePasswordField } from './MemberProfilePasswordField.js';

export function MemberProfileCreation({
  token,
  email,
  invitationError,
  onLogin,
}: {
  token: string;
  email?: string;
  invitationError: string;
  onLogin: () => Promise<void>;
}) {
  const [passwordError, setPasswordError] = useState('');
  const accepted = useRef<{ email: string; dspId: string } | null>(null);
  const save = useAction(
    async (form: HTMLFormElement) => {
      const values = new FormData(form);
      const password = String(values.get('password'));
      // A sign-in retry must not consume the accepted invitation again.
      if (!accepted.current)
        accepted.current = await api(`/api/invitations/${encodeURIComponent(token)}/accept`, {
          firstName: String(values.get('firstName')).trim(),
          lastName: String(values.get('lastName')).trim(),
          password,
        });
      await api('/api/auth/login', { email: accepted.current!.email, password });
      await onLogin();
      navigate(dspHash(accepted.current!.dspId));
    },
    { inline: true },
  );
  const unavailable = !email || Boolean(invitationError);
  return (
    <MemberProfileLayout>
      <form
        aria-busy={save.busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (unavailable || save.busy) return;
          const values = new FormData(event.currentTarget);
          if (values.get('password') !== values.get('confirmPassword')) {
            setPasswordError('The passwords must match.');
            return;
          }
          setPasswordError('');
          void save.run(event.currentTarget);
        }}
      >
        <div className="member-profile-fields">
          <label className="member-profile-wide">
            <span>Email address</span>
            <input type="email" autoComplete="email" readOnly value={email ?? ''} />
          </label>
          <label>
            <span>First name</span>
            <input
              name="firstName"
              autoComplete="given-name"
              required
              maxLength={100}
              pattern=".*\S.*"
              disabled={save.busy || unavailable || Boolean(accepted.current)}
            />
          </label>
          <label>
            <span>Last name</span>
            <input
              name="lastName"
              autoComplete="family-name"
              required
              maxLength={100}
              pattern=".*\S.*"
              disabled={save.busy || unavailable || Boolean(accepted.current)}
            />
          </label>
          <MemberProfilePasswordField disabled={save.busy || unavailable} />
          <MemberProfilePasswordField
            name="confirmPassword"
            label="Confirm password"
            disabled={save.busy || unavailable}
          />
        </div>
        <ErrorBox message={invitationError || passwordError || save.error} />
        <div className="member-profile-actions">
          <button className="primary" disabled={save.busy || unavailable}>
            {save.busy ? 'Please wait…' : 'Create profile'}
            <ArrowRight size={21} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="member-profile-back"
            disabled={save.busy}
            onClick={() => navigate(signInHash)}
          >
            Back to sign in
          </button>
        </div>
      </form>
    </MemberProfileLayout>
  );
}
