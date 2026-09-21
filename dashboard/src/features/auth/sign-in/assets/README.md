# Login van

`login-van.glb` is original geometry authored from the four vehicle photographs supplied
for the Signal design. Amazon/Prime marks depict that reference vehicle; no stock mesh or
reference photograph is embedded. Three.js is MIT licensed.

- Edit `tooling/assets/login-van.js`; run `npx tsx tooling/assets/export-login-van.ts` to rebuild.
  Its named parts and driver/passenger outlines are kept in the source. Authoring code is
  excluded from the shipped app; visitors load the prebuilt, merged model.
- Rotation, rendering limits, camera and dither size: `../van/settings.ts`.
- Ordered dithering: `../van/ordered-shader.ts`. White ink serves both themes.
- Contour geometry: `../LoginArtwork.tsx`; colors and layout: `../sign-in.css`.
- `login-van-poster.png` is the transparent render used while loading or without WebGL.
- Model and renderer load only above 700px. Keep the JS and CSS breakpoints together.
  Both are fingerprinted and compressed at build time, with immutable caching.
- Autoplay is intentional for every desktop motion preference, per the approved design.
  Rendering is capped at 30 fps / 1.5× DPR / 1.5 million pixels, suspended offscreen or in
  hidden tabs, and fully disposed on sign-in or switching to mobile. No server rendering.
