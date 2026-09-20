import { useEffect, useRef, type ReactNode } from 'react';
import { useViewportFit } from '../../ui/useViewportFit.js';
import { Brand } from '../../app/Brand.js';
import { useOnboardingMapReady } from './map-asset.js';
import { OnboardingMap } from './OnboardingMap.js';
import './onboarding.css';

export function OnboardingLayout({
  title,
  step,
  children,
}: {
  title: string;
  step?: 1 | 2;
  children: ReactNode;
}) {
  const fit = useViewportFit();
  const ready = useOnboardingMapReady();
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(title);
  useEffect(() => {
    if (previous.current !== title) heading.current?.focus();
    previous.current = title;
  }, [title]);
  return (
    <div className="onboarding-page" data-ready={ready} aria-busy={!ready}>
      <OnboardingMap />
      <header className="onboarding-brand">
        <Brand />
      </header>
      <main ref={fit.frame} className="onboarding-main">
        <section ref={fit.panel} className="onboarding-panel" aria-labelledby="onboarding-title">
          <h1 id="onboarding-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          {step && (
            <ol className="onboarding-progress" aria-label="Onboarding progress">
              <li aria-current={step === 1 ? 'step' : undefined}>
                <span className="onboarding-step-number">1</span>
                <span>DSP setup</span>
              </li>
              <li aria-current={step === 2 ? 'step' : undefined}>
                <span className="onboarding-step-number">2</span>
                <span>Your profile</span>
              </li>
            </ol>
          )}
          {children}
        </section>
      </main>
    </div>
  );
}
