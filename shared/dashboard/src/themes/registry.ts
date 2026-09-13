import type { ThemePack } from "./types.ts";

// A theme is registered by adding its folder. Vite includes its manifest,
// scoped CSS, and optional React components in the normal application build.
const modules = import.meta.glob<ThemePack>("./packs/*/index.ts", {
  eager: true,
  import: "default",
});
export const defaultThemeId = "precision";
export const themePacks = Object.values(modules).sort((a, b) =>
  a.id === defaultThemeId
    ? -1
    : b.id === defaultThemeId
      ? 1
      : a.name.localeCompare(b.name),
);
const byId = new Map<string, ThemePack>();
for (const pack of themePacks) {
  if (byId.has(pack.id)) throw new Error(`Duplicate theme pack: ${pack.id}`);
  byId.set(pack.id, pack);
}
if (!byId.has(defaultThemeId)) throw new Error("The default theme is required");
export function getThemePack(id: string) {
  return byId.get(id) || byId.get(defaultThemeId)!;
}
