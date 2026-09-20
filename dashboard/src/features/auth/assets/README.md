# Onboarding map

`onboarding-map.svg` is the shared Ventura County vector artwork for owner onboarding.
It contains the approved Camarillo–Ventura illustrative route and no geographic labels.
Source data: OpenFreeMap / OpenMapTiles / [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

- Change map colors in `../onboarding-map.css`; both themes reuse the same geometry.
- Form layout and responsive density live in `../onboarding.css`; fields live in
  `../DspSetupForm.tsx`. Map loading and desktop eligibility live in `../map-asset.ts`.
- The `region` group uses coordinates spanning x=0…1800, y=-800…1800.
  `OnboardingMap.tsx` frames that group to the viewport.
- Keep this as an independent SVG asset; do not inline it into React or replace it with a bitmap.
- Vite fingerprints it; the build generates Brotli/gzip representations for cached delivery.
- Desktop preloads the asset alongside the invitation and reveals the complete composition
  once ready. Mobile does not request it. Tests cover both behaviors and the transfer budget.
- Named route, station and pulse geometry serves a separate CSS animation layer.
  A round dash makes the moving marker; it follows the same path as the static route.
  Adjust `--map-cycle`, `--map-start-delay` and `--map-echo-spacing` in
  `../onboarding-map.css`; keyframe percentages set the departure/travel/arrival phases.
  Motion starts after the map is ready and is disabled for reduced motion; the form stays still.

# Login van

`login-van.glb` is original geometry authored from the four vehicle photographs supplied
for the Signal design. Amazon/Prime marks depict that reference vehicle; no stock mesh or
reference photograph is embedded. Three.js is MIT licensed.

- Edit `tooling/assets/login-van.js`; run `npx tsx tooling/export-login-van.ts` to rebuild.
  Its named parts and driver/passenger outlines are kept in the source. Authoring code is
  excluded from the shipped app; visitors load the prebuilt, merged model.
- Rotation, rendering limits, camera and dither size: `../van/settings.ts`.
- Ordered dithering: `../van/ordered-shader.ts`. White ink serves both themes.
- Contour geometry: `../LoginArtwork.tsx`; colors and layout: `../auth.css`.
- `login-van-poster.png` is the transparent render used while loading or without WebGL.
- Model and renderer load only above 700px. Keep the JS and CSS breakpoints together.
  Both are fingerprinted and compressed at build time, with immutable caching.
- Autoplay is intentional for every desktop motion preference, per the approved design.
  Rendering is capped at 30 fps / 1.5× DPR / 1.5 million pixels, suspended offscreen or in
  hidden tabs, and fully disposed on sign-in or switching to mobile. No server rendering.
