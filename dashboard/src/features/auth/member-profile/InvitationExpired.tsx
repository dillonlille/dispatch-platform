import { ArrowRight, ClockAlert } from 'lucide-react';
import { navigate, signInHash } from '../../../app/navigation.js';
import { MemberProfileLayout } from './MemberProfileLayout.js';

/** An invitation link that can no longer be used: expired, revoked or never issued. */
export function InvitationExpired() {
  return (
    <MemberProfileLayout title="Invitation expired" route="cancelled">
      <p className="member-profile-notice">
        <ClockAlert size={19} aria-hidden="true" />
        <span>This invitation has expired or was revoked. Ask your DSP for a new one.</span>
      </p>
      <div className="member-profile-actions">
        <button className="primary" onClick={() => navigate(signInHash)}>
          Go to sign in
          <ArrowRight size={21} aria-hidden="true" />
        </button>
      </div>
    </MemberProfileLayout>
  );
}
