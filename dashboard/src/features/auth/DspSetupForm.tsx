import { ArrowRight, ChevronDown } from 'lucide-react';
import { ErrorBox } from '../../ui/index.js';

export type DspSetup = {
  name: string;
  abbreviation: string;
  stationCode: string;
  timezone: string;
};
const timezones = [
  ...new Set([
    'America/Los_Angeles',
    'America/Chicago',
    'America/New_York',
    'America/Denver',
    'America/Phoenix',
    'America/Anchorage',
    'Pacific/Honolulu',
    'UTC',
    ...Intl.supportedValuesOf('timeZone'),
  ]),
].sort();

export function DspSetupForm({
  onSubmit,
  onBack,
  initial,
  busy = false,
  error = '',
  resume = false,
  hidden = false,
}: {
  onSubmit: (profile: DspSetup) => void;
  onBack: () => void;
  initial?: Partial<DspSetup>;
  busy?: boolean;
  error?: string;
  resume?: boolean;
  hidden?: boolean;
}) {
  return (
    <form
      hidden={hidden}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onSubmit({
          name: String(form.get('name')).trim(),
          abbreviation: String(form.get('abbreviation')).trim(),
          stationCode: String(form.get('stationCode')).toUpperCase(),
          timezone: String(form.get('timezone')),
        });
      }}
    >
      <div className="onboarding-fields">
        <label className="onboarding-wide">
          <span>
            DSP name{' '}
            <span className="onboarding-example" aria-hidden="true">
              (e.g. Northstar Logistics)
            </span>
          </span>
          <input
            name="name"
            aria-label="DSP name"
            placeholder="Your DSP name"
            autoComplete="organization"
            required
            minLength={2}
            maxLength={100}
            pattern=".*\S.*"
            defaultValue={initial?.name}
            disabled={busy}
          />
        </label>
        <label>
          <span>
            Abbreviation{' '}
            <span className="onboarding-example" aria-hidden="true">
              (e.g. NSTL)
            </span>
          </span>
          <input
            name="abbreviation"
            aria-label="Abbreviation"
            placeholder="Your DSP abbreviation"
            required
            maxLength={16}
            pattern=".*\S.*"
            defaultValue={initial?.abbreviation}
            disabled={busy}
          />
        </label>
        <label>
          <span>
            Station code{' '}
            <span className="onboarding-example" aria-hidden="true">
              (e.g. DOT4)
            </span>
          </span>
          <input
            name="stationCode"
            aria-label="Station code"
            placeholder="Your station code"
            required
            pattern="[A-Za-z0-9]{3,8}"
            maxLength={8}
            defaultValue={initial?.stationCode}
            disabled={busy}
          />
        </label>
        <label className="onboarding-wide">
          <span>Business timezone</span>
          <span className="onboarding-select">
            <select
              name="timezone"
              required
              defaultValue={initial?.timezone || 'America/Los_Angeles'}
              disabled={busy}
            >
              {timezones.map((timezone) => (
                <option key={timezone}>{timezone}</option>
              ))}
            </select>
            <ChevronDown size={18} aria-hidden="true" />
          </span>
        </label>
      </div>
      <ErrorBox message={error} />
      <div className="onboarding-actions">
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : resume ? 'Save DSP details' : 'Continue to profile'}
          <ArrowRight size={21} aria-hidden="true" />
        </button>
        <button type="button" className="onboarding-back" disabled={busy} onClick={onBack}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}
