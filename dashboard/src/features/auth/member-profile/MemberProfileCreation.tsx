import { useCallback, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '../../../app/api.js';
import { navigate, signInHash } from '../../../app/navigation.js';
import { signInAfterProfile } from '../../../app/sign-in-handoff.js';
import { useAction } from '../../../app/useAction.js';
import { ErrorBox } from '../../../ui/index.js';
import { MemberProfileLayout } from './MemberProfileLayout.js';
import { MemberProfilePasswordField } from './MemberProfilePasswordField.js';
import { useMemberCompletion } from './useMemberCompletion.js';
import { MEMBER_COMPLETION_MEDIA } from './member-completion-motion.js';
import type { MemberIdentity } from './MemberProfileCompletion.js';

export function MemberProfileCreation({
  token,
  email,
  dspName,
  role,
  invitationError,
}: {
  token: string;
  email?: string;
  dspName?: string;
  role?: string;
  invitationError: string;
}) {
  const [passwordError, setPasswordError] = useState('');
  const [created, setCreated] = useState<MemberIdentity | null>(null);
  const scene = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const { module, mounted } = useMemberCompletion();
  const finish = useCallback(
    (animate: boolean) => {
      if (created) signInAfterProfile(created.email, animate);
    },
    [created],
  );
  const save = useAction(
    async (form: HTMLFormElement) => {
      const values = new FormData(form);
      const firstName = String(values.get('firstName')).trim();
      const lastName = String(values.get('lastName')).trim();
      try {
        const accepted = await api<{ email: string }>(
          `/api/invitations/${encodeURIComponent(token)}/accept`,
          {
            firstName,
            lastName,
            password: String(values.get('password')),
          },
        );
        if (!mounted.current) return;
        if (!module.current || !matchMedia(MEMBER_COMPLETION_MEDIA).matches) {
          signInAfterProfile(accepted.email);
          return;
        }
        setCreated({
          firstName,
          lastName,
          email: accepted.email,
          dspName: dspName ?? '',
          role: role ?? 'Team member',
        });
      } catch (error) {
        submitting.current = false;
        throw error;
      }
    },
    { inline: true },
  );
  const unavailable = !email || Boolean(invitationError);
  const Completion = created && module.current?.MemberProfileCompletion;
  return (
    <>
      <MemberProfileLayout ref={scene} completing={Boolean(created)}>
        <form
          aria-busy={save.busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (unavailable || submitting.current) return;
            const values = new FormData(event.currentTarget);
            if (values.get('password') !== values.get('confirmPassword')) {
              setPasswordError('The passwords must match.');
              return;
            }
            setPasswordError('');
            submitting.current = true;
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
                disabled={save.busy || unavailable || Boolean(created)}
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
                disabled={save.busy || unavailable || Boolean(created)}
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
      {Completion && created && <Completion identity={created} scene={scene} onComplete={finish} />}
    </>
  );
}
