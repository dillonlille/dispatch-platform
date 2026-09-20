import { useEffect, useState, useSyncExternalStore } from 'react';
import mapUrl from './assets/onboarding-map.svg?url';

export { mapUrl };
// Match the dashboard's 700px mobile breakpoint; share one query across loading and rendering.
const desktopViewport = matchMedia('(min-width: 701px)');
const isDesktop = () => desktopViewport.matches;
function subscribeViewport(changed: () => void) {
  desktopViewport.addEventListener('change', changed);
  return () => desktopViewport.removeEventListener('change', changed);
}
let ready = false;
let pending: Promise<void> | undefined;

/** One browser-cached resource serves both themes; a failed image never blocks the form. */
function loadMap() {
  return (pending ??= new Promise<void>((resolve) => {
    const image = new Image();
    image.fetchPriority = 'high';
    image.onload = image.onerror = () => {
      ready = true;
      resolve();
    };
    image.src = mapUrl;
  }));
}

/** Start in parallel with the invitation's initial requests, before the form mounts. */
export function preloadOnboardingMap() {
  if (window.location.hash.startsWith('#invite?') && isDesktop()) void loadMap();
}

export function useOnboardingMap() {
  const desktop = useSyncExternalStore(subscribeViewport, isDesktop);
  const [loaded, setLoaded] = useState(() => ready || !desktop);
  useEffect(() => {
    if (loaded || !desktop) return;
    let active = true;
    void loadMap().then(() => {
      if (active) setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [desktop, loaded]);
  return { desktop, ready: loaded || !desktop };
}
