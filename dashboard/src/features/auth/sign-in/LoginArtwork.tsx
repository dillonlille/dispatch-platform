import { useSyncExternalStore } from 'react';
import { Brand } from '../../../app/Brand.js';
import { LoginVan } from './LoginVan.js';

// Keep in sync with auth.css. Mobile never imports Three.js or fetches the model/poster.
const desktopQuery = matchMedia('(min-width: 701px)');
const isDesktop = () => desktopQuery.matches;
function subscribe(changed: () => void) {
  desktopQuery.addEventListener('change', changed);
  return () => desktopQuery.removeEventListener('change', changed);
}
const contourPath =
  'M-100 150C40-80 360-90 480 75S740 175 880 290 870 600 685 665 720 925 485 1090 100 1070 5 875 130 640-65 485-240 320-100 150Z';
const contours = Array.from({ length: 12 }, (_, index) => 1 - index * 0.047);

export function LoginArtwork() {
  const desktop = useSyncExternalStore(subscribe, isDesktop);
  return (
    <aside className="login-art" aria-hidden="true">
      <Brand />
      <svg
        className="login-contours"
        viewBox="0 0 800 1000"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        <g stroke="currentColor" strokeWidth="1.2">
          {contours.map((scale) => (
            <path
              key={scale}
              transform={`translate(400 470) scale(${scale}) translate(-400 -470)`}
              d={contourPath}
            />
          ))}
        </g>
      </svg>
      {desktop && <LoginVan />}
      <span className="login-art-footer">DISPATCH PLATFORM</span>
    </aside>
  );
}
