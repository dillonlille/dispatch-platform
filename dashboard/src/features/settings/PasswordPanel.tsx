import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { PasswordDialog } from './PasswordDialog.js';

export function PasswordPanel() {
  const [open, setOpen] = useState(false);
  return (
    <section className="security-panel" aria-labelledby="security-password-title">
      <div>
        <div className="security-panel-heading">
          <LockKeyhole size={20} aria-hidden="true" />
          <h2 id="security-password-title">Password</h2>
        </div>
        <div className="security-panel-value">
          <span className="security-password-dots" aria-label="Password is set">
            ••••••••••
          </span>
        </div>
      </div>
      <div className="security-panel-actions">
        <button onClick={() => setOpen(true)}>Change password</button>
      </div>
      {open && <PasswordDialog close={() => setOpen(false)} />}
    </section>
  );
}
