# Member profile map

`member-profile-map.svg` is this screen's independent copy of the DSP onboarding design.
Source data: OpenFreeMap / OpenMapTiles / [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

- Keep member profile forms, styles, map loading and artwork inside `member-profile/`.
- Edit `../member-profile.css` for layout and `../member-profile-map.css` for map colors, motion
  and the settled routes. `#delivery-cancelled` crosses out the stop for an expired link.
- Desktop loads this asset after invitation lookup. Mobile skips it; reduced motion disables animation.
- Do not import page components or styles from `sign-in/` or `dsp-onboarding/`.
