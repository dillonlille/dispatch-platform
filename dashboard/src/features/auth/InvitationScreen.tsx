import { Brand } from '../../app/Brand.js';
import { useData } from '../../app/api.js';
import { Loading } from '../../ui/index.js';
import { MemberProfileCreation } from './member-profile/MemberProfileCreation.js';
import { OwnerOnboarding } from './dsp-onboarding/OwnerOnboarding.js';
import './invitation.css';

export function InvitationScreen({
  token,
  onLogin,
}: {
  token: string;
  onLogin: () => Promise<void>;
}) {
  const invitation = useData<{
    email: string;
    dspName: string;
    role: string;
    stationCode: string;
    timezone: string;
    onboarding: boolean;
  }>(`/api/invitations/${encodeURIComponent(token)}`);
  if (!invitation.data && !invitation.error)
    return (
      <main className="invitation-loading">
        <Brand />
        <Loading />
      </main>
    );
  // Choose the screen before loading its artwork; the invitation flows stay independent.
  if (invitation.data?.onboarding && token)
    return <OwnerOnboarding token={token} email={invitation.data.email} onLogin={onLogin} />;
  return (
    <MemberProfileCreation
      token={token}
      email={invitation.data?.email}
      dspName={invitation.data?.dspName}
      role={invitation.data?.role}
      stationCode={invitation.data?.stationCode}
      timezone={invitation.data?.timezone}
      invitationError={invitation.error}
    />
  );
}
