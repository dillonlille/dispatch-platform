# Dispatch theme packs

Settings → Theme separates the visual **Theme** from its **Appearance** (Light,
Dark, or System). Precision is the default. Preferences are stored in localStorage
under `dispatch:theme:v1:<authenticated-user-id>` as `{ themeId, appearance }`.
They are local to that account on that browser, persist across DSP workspaces,
and do not change anyone else's settings. Sign-out returns to the default light
appearance. Missing packs and invalid saved values fall back to Precision.

## Add a theme

From `dashboard`:

```sh
cp -R frontend/src/themes/starter frontend/src/themes/packs/my-theme
npm run build
npm run preview:ui
```

Rename `id`, `name`, `description`, and the matching CSS selectors. Restart an
existing preview/server after building: it snapshots browser assets at startup.
The registry discovers every `packs/*/index.ts` manifest automatically, so no
Settings or application logic needs editing. The starter itself is not registered.

A pack folder can contain CSS, local assets, and optional React components. It is
source code included in the application build; this is not a runtime download or
an upload/import facility. Keep ids stable so saved selections remain valid.

## Design tokens and CSS

[`tokens.css`](./tokens.css) is the public starting palette and geometry contract.
Override just the values you need. Useful groups:

- Surfaces: `--background`, `--card`, `--popover`, `--sidebar`, `--surface`.
- Text: `--foreground`, `--muted-foreground`, `--primary-foreground`.
- Controls: `--primary`, `--primary-hover`, `--selection`, `--accent`, `--border`,
  `--input`, `--ring`, `--radius`, `--control-height`.
- Status: `--success`, `--warning`, `--destructive`, their surface/border tokens,
  and `--danger-button` (white button text).
- Layout: `--font-family`, `--heading-size`, `--body-size`, `--sidebar-width`,
  `--page-gutter`, `--table-row-padding`, `--motion-duration`.
- DSP identity: `--slate`, `--sage`, `--violet`, `--steel` and their `-surface` tokens.

Always scope selectors to `:root[data-theme-pack="your-id"]`. Add
`[data-theme="dark"]` for dark overrides. Include `.theme-preview-scope` with the
same attributes to theme the menu previews. This specificity also ensures pack
values override defaults regardless of CSS import order. Never use global `:root`
or unscoped component selectors in a pack: all registered CSS is bundled together.

The same semantic tokens style React pages and the existing Backups/Updates
controllers, including native dialogs, menus, alerts, inputs, and progress states.
Preview schematics are code-native and read these tokens. Light uses a white canvas;
dark uses graphite with more legible accent and status colors.

## Optional shared presentation components

A manifest can replace `ShellLayout`, `PageHeading`, or `DspAvatar` in its
`components` property. Unspecified components inherit Dispatch's defaults.
Contracts are exported from [`types.ts`](./types.ts), and unwrapped default
components are available from [`sdk.ts`](./sdk.ts). Example:

```tsx
import type { PageHeadingProps } from "@/themes/types";

export function MyHeading({ title, description, children }: PageHeadingProps) {
  return (
    <div className="my-heading">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div>{children}</div>}
    </div>
  );
}
```

Then add `components: { PageHeading: MyHeading }` to the manifest. Do not call the
_themed_ component from its replacement, which would recurse; compose the exported
`DefaultPageHeading` when you want to extend the existing presentation.

`ShellLayout` receives navigation, mobileNavigation, header, banner, and children.
Render every slot, retain `<main id="main-content" tabIndex={-1}>`, and provide
usable desktop/mobile navigation. Dispatch owns route permissions, the account
menu, mobile sheet behavior, DSP support-view controls, and page content. Keep that
logic in the application rather than copying it into themes.

`DspAvatar` replaces React DSP avatars. Legacy backup avatars share the identity
helper and CSS tokens; they do not mount custom React avatar components. Similarly,
legacy backup headings follow CSS tokens rather than the React PageHeading slot.
Theme those surfaces with scoped CSS. Full page replacements are outside this API.

## Verify a pack

Test both appearances and System; refresh and switch accounts to check persistence.
Inspect DSPs, Backups (including native dialogs), Updates, Team, and Settings at
1536×1024 and 390×844. Check text contrast, focus, keyboard navigation, long names,
empty states, menus, and reduced motion. Theme switching must not call operation
APIs. Run `npm run build` and `npm run test:ui`; commit the rebuilt browser assets
with the theme source.
