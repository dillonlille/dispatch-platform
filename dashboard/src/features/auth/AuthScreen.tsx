import { hashQuery } from '../../app/navigation.js';
import { InvitationScreen } from './InvitationScreen.js';
import { SignInScreen } from './sign-in/SignInScreen.js';

/** Route entry only; each screen owns its form, layout and behavior. */
export function AuthScreen({ onLogin }: { onLogin: () => Promise<void> }) {
  if (window.location.hash.startsWith('#invite?')) {
    const token = hashQuery().get('token') ?? '';
    return <InvitationScreen key={token} token={token} onLogin={onLogin} />;
  }
  return <SignInScreen onLogin={onLogin} />;
}
