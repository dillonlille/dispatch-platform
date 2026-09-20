# Onboarding map

`onboarding-map.svg` is the shared Ventura County vector artwork for owner onboarding.
It contains the approved Camarillo–Ventura illustrative route and no geographic labels.
Source data: OpenFreeMap / OpenMapTiles / [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

- Change theme colors in `../onboarding.css`; both themes reuse the same geometry.
- The `region` group uses coordinates spanning x=0…1800, y=-800…1800.
  `OnboardingMap.tsx` frames that group to the viewport.
- Keep this as an independent SVG asset; do not inline it into React or replace it with a bitmap.
- Vite fingerprints it; the build generates Brotli/gzip representations for cached delivery.
- Desktop preloads the asset alongside the invitation and reveals the complete composition
  once ready. Mobile does not request it. Tests cover both behaviors and the transfer budget.
