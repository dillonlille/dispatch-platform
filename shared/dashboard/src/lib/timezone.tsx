import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { calendarDateAt, deviceTimeZone, validTimeZone } from "./date-time.ts";

const storageKey = (userId: string) => `dispatch:timezone:v1:${userId}`;
function readPreference(userId: string | null): string | null {
  try {
    const value = userId ? JSON.parse(localStorage.getItem(storageKey(userId)) || "null") : null;
    return validTimeZone(value?.timeZone) ? value.timeZone : null;
  } catch { return null; }
}
const TimezoneContext = createContext<{
  timeZone: string;
  deviceZone: string;
  preference: string | null;
  setPreference: (value: string | null) => void;
  storageUnavailable: boolean;
} | null>(null);

// Like appearance, display preferences belong to the signed-in user on this
// browser, including while a platform owner is viewing another DSP.
export function TimezoneProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [stored, setStored] = useState(() => ({ userId, preference: readPreference(userId), storageUnavailable: false }));
  if (stored.userId !== userId) setStored({ userId, preference: readPreference(userId), storageUnavailable: false });
  const [deviceZone, setDeviceZone] = useState(deviceTimeZone);
  useEffect(() => {
    const update = () => setDeviceZone(deviceTimeZone());
    const timer = window.setInterval(update, 60000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => {
    if (!userId) return;
    const update = (event: StorageEvent) => {
      if (event.key === null || event.key === storageKey(userId)) {
        setStored(current => current.userId === userId ? { ...current, preference: readPreference(userId) } : current);
      }
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [userId]);
  function setPreference(preference: string | null) {
    if (!userId || preference !== null && !validTimeZone(preference)) return;
    let storageUnavailable = false;
    try { localStorage.setItem(storageKey(userId), JSON.stringify({ timeZone: preference })); }
    catch { storageUnavailable = true; }
    setStored({ userId, preference, storageUnavailable });
  }
  return <TimezoneContext.Provider value={{ timeZone: stored.preference || deviceZone, deviceZone,
    preference: stored.preference, setPreference, storageUnavailable: stored.storageUnavailable }}>{children}</TimezoneContext.Provider>;
}

export function useTimezone() {
  const value = useContext(TimezoneContext);
  if (!value) throw new Error("TimezoneProvider is required");
  return value;
}

export function useBusinessToday(timeZone: string): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 30000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  // Derive from the current zone immediately when switching DSPs/settings.
  return calendarDateAt(timeZone, now);
}
