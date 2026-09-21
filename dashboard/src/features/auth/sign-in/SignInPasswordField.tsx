import { useState, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export function SignInPasswordField({
  name = 'password',
  label = 'Password',
  current = false,
  action,
  autoFocus = false,
}: {
  name?: string;
  label?: string;
  current?: boolean;
  action?: ReactNode;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="auth-password">
      <div className="auth-label-row">
        <label htmlFor={name}>{label}</label>
        {action}
      </div>
      <div className="auth-password-input">
        <input
          id={name}
          name={name}
          autoFocus={autoFocus}
          type={visible ? 'text' : 'password'}
          minLength={current ? 1 : 8}
          maxLength={128}
          autoComplete={current ? 'current-password' : 'new-password'}
          placeholder={current ? 'Enter your password' : undefined}
          required
        />
        <button
          type="button"
          className="auth-reveal"
          aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          <Icon size={18} />
        </button>
      </div>
    </div>
  );
}
