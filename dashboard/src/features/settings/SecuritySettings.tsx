import { PasswordPanel } from './PasswordPanel.js';
import { SessionsPanel } from './SessionsPanel.js';
import { useAccountSessions } from '../../app/endpoints.js';
import { MultiFactorPanel } from './MultiFactorPanel.js';

export function SecuritySettings() {
  const sessions = useAccountSessions();
  return (
    <div className="security-settings">
      <PasswordPanel />
      <MultiFactorPanel />
      <SessionsPanel sessions={sessions} />
    </div>
  );
}
