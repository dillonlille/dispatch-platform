import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

import { defaultThemeId, getThemePack } from "@/themes/registry";
import type { Appearance, ThemePack } from "@/themes/types";

export type Theme = Appearance;
type Preference = { themeId: string; appearance: Appearance };
const defaultPreference: Preference = {
  themeId: defaultThemeId,
  appearance: "light",
};
const isTheme = (value: unknown): value is Theme =>
  value === "light" || value === "dark" || value === "system";
const storageKey = (userId: string) => `dispatch:theme:v1:${userId}`;
function readTheme(userId: string | null): Preference {
  try {
    const raw = userId ? localStorage.getItem(storageKey(userId)) : null;
    if (!raw) return defaultPreference;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return defaultPreference;
    return {
      themeId: getThemePack(value.themeId).id,
      appearance: isTheme(value.appearance) ? value.appearance : "light",
    };
  } catch {
    return defaultPreference;
  }
}
const ThemeContext = createContext<{
  appearance: Appearance;
  themePack: ThemePack;
  setAppearance: (appearance: Appearance) => void;
  setThemePack: (id: string) => void;
  storageUnavailable: boolean;
} | null>(null);

// Preferences are scoped to the authenticated user, never the DSP being viewed.
// Preferences stay in this browser; no workspace or account mutation is sent.
export function ThemeProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  const [stored, saveStored] = useState(() => ({
    userId,
    preference: readTheme(userId),
    storageUnavailable: false,
  }));
  // Reset preferences before rendering a different user without remounting the
  // application: login/invitation requests must retain their pending/error state.
  if (stored.userId !== userId) {
    saveStored({
      userId,
      preference: readTheme(userId),
      storageUnavailable: false,
    });
  }
  const { preference, storageUnavailable } = stored;
  const { appearance, themeId } = preference;
  const themePack = getThemePack(themeId);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolved =
    appearance === "system" ? (systemDark ? "dark" : "light") : appearance;

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePack = themePack.id;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        getComputedStyle(document.documentElement)
          .getPropertyValue("--background")
          .trim(),
      );
  }, [resolved, themePack.id]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!userId) return;
    const update = (event: StorageEvent) => {
      if (event.key === null || event.key === storageKey(userId)) {
        saveStored((current) =>
          current.userId === userId
            ? { ...current, preference: readTheme(userId) }
            : current,
        );
      }
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [userId]);

  function persist(next: Preference) {
    let storageUnavailable = false;
    try {
      if (!userId) return;
      localStorage.setItem(storageKey(userId), JSON.stringify(next));
    } catch {
      storageUnavailable = true;
    }
    saveStored({ userId, preference: next, storageUnavailable });
  }
  return (
    <ThemeContext.Provider
      value={{
        appearance,
        themePack,
        storageUnavailable,
        setAppearance: (next) => persist({ ...preference, appearance: next }),
        setThemePack: (id) =>
          persist({ ...preference, themeId: getThemePack(id).id }),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("ThemeProvider is required");
  return context;
}
