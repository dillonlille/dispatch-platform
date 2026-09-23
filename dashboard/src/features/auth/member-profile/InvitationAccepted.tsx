import { ArrowRight, CircleCheck } from 'lucide-react';
import { signInAfterProfile } from '../../../app/sign-in-handoff.js';
import { DspAvatar } from '../../../ui/index.js';
import { MemberProfileLayout } from './MemberProfileLayout.js';

/** A used invitation link: its account already exists, so Sign In is the way on. */
export function InvitationAccepted({
  email,
  dspName,
  role,
}: {
  email: string;
  dspName: string;
  role: string;
}) {
  return (
    <MemberProfileLayout
      title="Already accepted"
      route="delivered"
      eyebrow={
        <p className="member-profile-invitation">
          <DspAvatar name={dspName} />
          <strong>{dspName}</strong>
          <span className="member-profile-role">{role}</span>
        </p>
      }
    >
      <p className="member-profile-notice member-profile-notice-done">
        <CircleCheck size={19} aria-hidden="true" />
        <span>You joined {dspName} with this invitation. Sign in with your Dispatch password.</span>
      </p>
      <div className="member-profile-actions">
        <button className="primary" onClick={() => signInAfterProfile(email)}>
          Sign in
          <ArrowRight size={21} aria-hidden="true" />
        </button>
      </div>
    </MemberProfileLayout>
  );
}
