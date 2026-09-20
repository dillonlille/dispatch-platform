import { useEffect, useState } from 'react';
import mapUrl from './assets/onboarding-map.svg?url';

export { mapUrl };
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
  if (window.location.hash.startsWith('#invite?') && matchMedia('(min-width: 701px)').matches)
    void loadMap();
}

export function useOnboardingMapReady() {
  const [loaded, setLoaded] = useState(() => ready || !matchMedia('(min-width: 701px)').matches);
  useEffect(() => {
    if (loaded) return;
    let active = true;
    void loadMap().then(() => {
      if (active) setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [loaded]);
  return loaded;
}
