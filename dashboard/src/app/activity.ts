const events = [
  'pointermove',
  'pointerdown',
  'keydown',
  'input',
  'wheel',
  'touchstart',
  'scroll',
  'focusin',
];
/** Calls `listener` whenever the person uses the page; returns the unsubscribe. */
export function onActivity(listener: () => void) {
  for (const name of events)
    window.addEventListener(name, listener, { capture: true, passive: true });
  return () => {
    for (const name of events) window.removeEventListener(name, listener, true);
  };
}
