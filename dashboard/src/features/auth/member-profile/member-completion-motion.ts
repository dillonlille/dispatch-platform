export const MEMBER_COMPLETION_MEDIA =
  '(min-width: 701px) and (prefers-reduced-motion: no-preference)';

/** Milliseconds. Tune the sequence here without touching the form or Sign In. */
export const MEMBER_COMPLETION_TIMING = {
  fade: 220,
  drop: 900,
  settle: 1100,
  hold: 2000,
  lift: 520,
};

/** Successive turning angles. Each half-swing eases to rest before reversing. */
export const MEMBER_COMPLETION_SWAY = {
  angles: [5, -2.25, 0.75, 0],
  easing: 'cubic-bezier(.37,0,.63,1)',
};
