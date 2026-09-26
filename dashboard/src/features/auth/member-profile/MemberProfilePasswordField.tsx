import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export function MemberProfilePasswordField({
  name = 'password',
  label = 'Password',
  disabled,
}: {
  name?: string;
  label?: string;
  disabled: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  const id = `member-profile-${name}`;
  return (
    <div className="member-profile-wide member-profile-password">
      <label htmlFor={id}>{label}</label>
      <div className="member-profile-password-input">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          required
          minLength={15}
          maxLength={128}
          disabled={disabled}
        />
        <button
          type="button"
          className="member-profile-reveal"
          aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible(!visible)}
        >
          <Icon size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
