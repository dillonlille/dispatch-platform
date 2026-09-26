import { useState } from 'react';
import { consumeHashToken } from '../../app/navigation.js';
import { InvitationScreen } from './InvitationScreen.js';
import { SignInScreen } from './sign-in/SignInScreen.js';

/** Route entry only; each screen owns its form, layout and behavior. */
export function AuthScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  const [invitation] = useState(() => consumeHashToken('invite'));
  if (invitation !== undefined)
    return <InvitationScreen key={invitation} token={invitation} onLogin={onLogin} />;
  return <SignInScreen onLogin={onLogin} />;
}
