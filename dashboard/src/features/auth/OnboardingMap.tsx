import { useEffect, useRef, useState } from 'react';
import { mapUrl } from './map-asset.js';

/** The geographic asset is requested only when the desktop map is mounted. */
export function OnboardingMap() {
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 701px)').matches);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const media = matchMedia('(min-width: 701px)');
    const changed = () => setDesktop(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const mapWidth = Math.min(width <= 1100 ? 1760 : 1440, (2600 * width) / height);
      const mapHeight = (mapWidth * height) / width;
      const top = Math.max(
        -800,
        Math.min(
          1800 - mapHeight,
          mapHeight > 1000 ? (1000 - mapHeight) / 2 : 600 - mapHeight * 0.68,
        ),
      );
      element.setAttribute('viewBox', `0 ${top} ${mapWidth} ${mapHeight}`);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [desktop]);
  return desktop ? (
    <svg ref={svg} className="onboarding-map" aria-hidden="true" focusable="false">
      <use href={`${mapUrl}#region`} />
    </svg>
  ) : null;
}
