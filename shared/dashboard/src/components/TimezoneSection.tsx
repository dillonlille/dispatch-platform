import { useTimezone } from "@/lib/timezone";
import { validTimeZone } from "@/lib/date-time";

const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [
  "America/Los_Angeles", "America/Phoenix", "America/Denver", "America/Chicago", "America/New_York", "Europe/London",
];

export function TimezoneSection() {
  const { timeZone, deviceZone, preference, setPreference, storageUnavailable } = useTimezone();
  const options = [...new Set(["UTC", deviceZone, preference, ...supported].filter(validTimeZone))].sort();
  return <section className="settings-section">
    <div><h2>Date &amp; time</h2><p>Choose how event times appear for you.</p></div>
    <div className="theme-pack-field">
      <label htmlFor="display-timezone">Display timezone</label>
      <select id="display-timezone" value={preference || "automatic"}
        onChange={event => setPreference(event.target.value === "automatic" ? null : event.target.value)}
        aria-describedby="display-timezone-description">
        <option value="automatic">Automatic — device timezone ({deviceZone.replaceAll("_", " ")})</option>
        {options.map(zone => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}
      </select>
      <p id="display-timezone-description">Sync and activity times use {timeZone.replaceAll("_", " ")}. Timecards keep the DSP’s business timezone.</p>
      <p>Saved for your account on this browser.</p>
      {storageUnavailable && <p role="status">Applied for this visit. Browser storage is unavailable, so this preference could not be saved.</p>}
    </div>
  </section>;
}
