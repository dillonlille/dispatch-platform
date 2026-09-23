import { Brand } from '../../app/Brand.js';
import { useData } from '../../app/api.js';
import { Loading } from '../../ui/index.js';
import { InvitationAccepted } from './member-profile/InvitationAccepted.js';
import { InvitationExpired } from './member-profile/InvitationExpired.js';
import { MemberProfileCreation } from './member-profile/MemberProfileCreation.js';
import { OwnerOnboarding } from './dsp-onboarding/OwnerOnboarding.js';
import './invitation.css';

type OpenInvitation = {
  accepted?: false;
  email: string;
  dspName: string;
  role: string;
  stationCode: string;
  timezone: string;
  onboarding: boolean;
};
type AcceptedInvitation = { accepted: true; email: string; dspName: string; role: string };

export function InvitationScreen({
  token,
  onLogin,
}: {
  token: string;
  onLogin: () => Promise<void>;
}) {
  const invitation = useData<OpenInvitation | AcceptedInvitation>(
    `/api/invitations/${encodeURIComponent(token)}`,
  );
  const data = invitation.data;
  if (!data && !invitation.error)
    return (
      <main className="invitation-loading">
        <Brand />
        <Loading />
      </main>
    );
  // A spent link gets its own page; any other failure keeps the form with its error.
  if (invitation.errorCode === 'invitation_expired') return <InvitationExpired />;
  if (data?.accepted)
    return <InvitationAccepted email={data.email} dspName={data.dspName} role={data.role} />;
  // Choose the screen before loading its artwork; the invitation flows stay independent.
  if (data?.onboarding && token)
    return <OwnerOnboarding token={token} email={data.email} onLogin={onLogin} />;
  return (
    <MemberProfileCreation
      token={token}
      email={data?.email}
      dspName={data?.dspName}
      role={data?.role}
      stationCode={data?.stationCode}
      timezone={data?.timezone}
      invitationError={invitation.error}
    />
  );
}
