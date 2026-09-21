import { api } from '../../../app/api.js';
import { useAction } from '../../../app/useAction.js';
import { DspSetupForm, type DspSetup } from './DspSetupForm.js';
import { OnboardingLayout } from './OnboardingLayout.js';

/** Resume setup for owners who already created their account before the new flow. */
export function DspOnboarding({
  complete,
  signOut,
}: {
  complete: () => Promise<void>;
  signOut: () => Promise<void>;
}) {
  const save = useAction((profile: DspSetup) => api('/api/dsp/profile', profile).then(complete), {
    inline: true,
  });
  const logout = useAction(signOut, { inline: true });
  return (
    <OnboardingLayout title="Set up your DSP">
      <DspSetupForm
        resume
        busy={save.busy || logout.busy}
        error={save.error || logout.error}
        onSubmit={(profile) => {
          void save.run(profile);
        }}
        onBack={() => {
          void logout.run();
        }}
      />
    </OnboardingLayout>
  );
}
