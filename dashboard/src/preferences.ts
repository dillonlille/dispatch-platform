let user = 'signed-out';
let timezone: string | undefined;
export function initializePreferences(userId: string) {
  user = userId;
  timezone = undefined;
  try {
    const saved = localStorage.getItem(`dispatch-timezone:${userId}`);
    if (saved) {
      new Intl.DateTimeFormat('en', { timeZone: saved });
      timezone = saved;
    }
  } catch {
    /* Use the device timezone when storage is unavailable. */
  }
}
export function displayTimezone() {
  return timezone;
}
export function saveTimezone(value: string) {
  if (value) new Intl.DateTimeFormat('en', { timeZone: value });
  timezone = value || undefined;
  try {
    if (value) localStorage.setItem(`dispatch-timezone:${user}`, value);
    else localStorage.removeItem(`dispatch-timezone:${user}`);
  } catch {
    /* The selected timezone still applies for this session. */
  }
  window.dispatchEvent(new Event('dispatch-preferences'));
}
