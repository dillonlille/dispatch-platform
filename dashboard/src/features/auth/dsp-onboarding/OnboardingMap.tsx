import { useEffect, useRef } from 'react';
import { mapUrl } from './map-asset.js';
import './onboarding-map.css';

/** The geographic asset is requested only when the desktop map is mounted. */
export function OnboardingMap({ desktop }: { desktop: boolean }) {
  const map = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = map.current;
    if (!element) return;
    const layers = element.querySelectorAll('svg');
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
      for (const layer of layers)
        layer.setAttribute('viewBox', `0 ${top} ${mapWidth} ${mapHeight}`);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [desktop]);
  return desktop ? (
    <div ref={map} className="onboarding-map" aria-hidden="true">
      <svg className="onboarding-map-layer" focusable="false">
        <use href={`${mapUrl}#region`} />
      </svg>
      {/* Keep animated paint separate from the detailed, static geographic layer. */}
      <svg className="onboarding-map-layer onboarding-map-motion" focusable="false">
        <use className="onboarding-departure-pulse" href={`${mapUrl}#departure-pulse`} />
        <use className="onboarding-route-trail" href={`${mapUrl}#delivery-route`} />
        {/* A round, near-zero-length dash follows the shared route without a JS frame loop. */}
        <g className="onboarding-traveler">
          <use className="onboarding-traveler-halo" href={`${mapUrl}#delivery-route`} />
          <use className="onboarding-traveler-outline" href={`${mapUrl}#delivery-route`} />
          <use className="onboarding-traveler-core" href={`${mapUrl}#delivery-route`} />
        </g>
        <use className="onboarding-destination-pulse" href={`${mapUrl}#delivery-pulse`} />
        <use
          className="onboarding-destination-pulse onboarding-destination-echo"
          href={`${mapUrl}#delivery-pulse`}
        />
        {/* The marker emerges from beneath the station instead of covering its logo. */}
        <use href={`${mapUrl}#delivery-station`} />
      </svg>
    </div>
  ) : null;
}
