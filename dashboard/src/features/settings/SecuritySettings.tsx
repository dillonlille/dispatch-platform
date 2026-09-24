import { PasswordPanel } from './PasswordPanel.js';
import { SessionsPanel } from './SessionsPanel.js';
import { useAccountSessions } from '../../app/endpoints.js';

export function SecuritySettings() {
  const sessions = useAccountSessions();
  return (
    <div className="security-settings">
      <PasswordPanel />
      <SessionsPanel sessions={sessions} />
    </div>
  );
}
