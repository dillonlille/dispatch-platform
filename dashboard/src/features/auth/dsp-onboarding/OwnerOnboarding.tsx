import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { api } from '../../../app/api.js';
import { useAction } from '../../../app/useAction.js';
import { dspHash, navigate, signInHash } from '../../../app/navigation.js';
import { ErrorBox } from '../../../ui/index.js';
import { DspSetupForm, type DspSetup } from './DspSetupForm.js';
import { OnboardingLayout } from './OnboardingLayout.js';

export function OwnerOnboarding({
  token,
  email,
  onLogin,
}: {
  token: string;
  email: string;
  onLogin: () => Promise<void>;
}) {
  const [profile, setProfile] = useState<DspSetup>();
  const [step, setStep] = useState<1 | 2>(1);
  const [passwordError, setPasswordError] = useState('');
  // If sign-in fails after acceptance, retry sign-in without consuming the invitation again.
  const accepted = useRef<{ email: string; dspId: string } | null>(null);
  const save = useAction(
    async (form: HTMLFormElement) => {
      const values = new FormData(form);
      const password = String(values.get('password'));
      if (!accepted.current) {
        accepted.current = await api(`/api/invitations/${encodeURIComponent(token)}/accept`, {
          firstName: String(values.get('firstName')).trim(),
          lastName: String(values.get('lastName')).trim(),
          password,
          dspProfile: profile,
        });
      }
      await api('/api/auth/login', { email: accepted.current!.email, password });
      await onLogin();
      navigate(dspHash(accepted.current!.dspId));
    },
    { inline: true },
  );
  const backToSignIn = () => navigate(signInHash);
  return (
    <OnboardingLayout title={step === 1 ? 'Set up your DSP' : 'Create your profile'} step={step}>
      <DspSetupForm
        hidden={step !== 1}
        onSubmit={(next) => {
          setProfile(next);
          setStep(2);
        }}
        onBack={backToSignIn}
      />
      <form
        hidden={step !== 2}
        aria-busy={save.busy}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          if (form.get('password') !== form.get('confirmPassword')) {
            setPasswordError('The passwords must match.');
            return;
          }
          setPasswordError('');
          void save.run(event.currentTarget);
        }}
      >
        <div className="onboarding-fields">
          <label className="onboarding-wide">
            <span>Email address</span>
            <input type="email" autoComplete="email" readOnly value={email} />
          </label>
          <label>
            <span>First name</span>
            <input
              name="firstName"
              autoComplete="given-name"
              required
              maxLength={100}
              pattern=".*\S.*"
              disabled={save.busy || Boolean(accepted.current)}
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
              disabled={save.busy || Boolean(accepted.current)}
            />
          </label>
          <label className="onboarding-wide">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={15}
              maxLength={128}
              disabled={save.busy}
            />
          </label>
          <label className="onboarding-wide">
            <span>Confirm password</span>
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={15}
              maxLength={128}
              disabled={save.busy}
            />
          </label>
        </div>
        <ErrorBox message={passwordError || save.error} />
        <div className="onboarding-actions">
          <button className="primary" disabled={save.busy}>
            {save.busy ? 'Please wait…' : 'Finish setup'}
            <ArrowRight size={21} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="onboarding-back"
            disabled={save.busy}
            onClick={() => {
              if (accepted.current) backToSignIn();
              else setStep(1);
            }}
          >
            {accepted.current ? null : <ArrowLeft size={15} aria-hidden="true" />}
            {accepted.current ? 'Back to sign in' : 'Back to DSP setup'}
          </button>
        </div>
      </form>
    </OnboardingLayout>
  );
}
