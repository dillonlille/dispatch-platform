import { useState } from 'react';
import { readAppearance, saveAppearance, type Appearance as Theme } from './appearance.js';

const choices: { value: Theme; label: string; description: string }[] = [
  { value: 'light', label: 'Light', description: 'A bright, clean workspace.' },
  { value: 'dark', label: 'Dark', description: 'A calm, low-light workspace.' },
  {
    value: 'system',
    label: 'System',
    description: 'Match your device settings.',
  },
];

function ThemePreview({ mode }: { mode: 'light' | 'dark' }) {
  return (
    <span
      className="theme-preview-ui theme-preview-scope"
      data-theme={mode}
      data-theme-pack="precision"
    >
      <span className="theme-preview-sidebar">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="theme-preview-content">
        <span className="theme-preview-heading" />
        <span className="theme-preview-subheading" />
        <span className="theme-preview-table">
          {[0, 1, 2].map((row) => (
            <span key={row}>
              <i />
              <i />
              <i />
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

export function ThemeSection({ userId }: { userId: string }) {
  const [appearance, setMode] = useState<Theme>(() => readAppearance(userId));
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  function setAppearance(mode: Theme) {
    setMode(mode);
    setStorageUnavailable(!saveAppearance(userId, mode));
  }
  return (
    <section className="theme-section">
      <fieldset aria-describedby="theme-persistence">
        <legend>Appearance</legend>
        <div className="theme-options">
          {choices.map(({ value, label, description }) => (
            <label className="theme-option" key={value}>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={appearance === value}
                onChange={() => setAppearance(value)}
                aria-label={label}
                aria-describedby={`theme-${value}-description`}
              />
              <span className={`theme-preview theme-preview-${value}`} aria-hidden="true">
                <ThemePreview mode={value === 'dark' ? 'dark' : 'light'} />
                {value === 'system' && <ThemePreview mode="dark" />}
              </span>
              <span className="theme-option-label">{label}</span>
              <span id={`theme-${value}-description`} className="theme-option-description">
                {description}
              </span>
            </label>
          ))}
        </div>
        <p id="theme-persistence" className="theme-persistence">
          Saved for your account on this browser. Other users keep their own theme.
        </p>
        {storageUnavailable && (
          <p role="status" className="theme-storage-notice">
            Theme applied for this visit. Browser storage is unavailable, so it could not be saved.
          </p>
        )}
      </fieldset>
    </section>
  );
}
