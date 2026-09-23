import type { ReactNode, Ref } from 'react';
import { Brand } from '../../../app/Brand.js';
import { useViewportFit } from '../../../ui/useViewportFit.js';
import { MemberProfileMap, type MemberProfileRoute } from './MemberProfileMap.js';
import { useMemberProfileMap } from './member-profile-map-asset.js';
import './member-profile.css';

export function MemberProfileLayout({
  children,
  ref,
  completing = false,
  title = 'Create your profile',
  eyebrow,
  route,
}: {
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  completing?: boolean;
  title?: string;
  /** Sits above the title. */
  eyebrow?: ReactNode;
  route?: MemberProfileRoute;
}) {
  const fit = useViewportFit();
  const { desktop, ready } = useMemberProfileMap();
  return (
    <div
      ref={ref}
      className="member-profile-page"
      data-ready={ready}
      aria-busy={!ready}
      inert={completing}
      aria-hidden={completing || undefined}
    >
      <MemberProfileMap desktop={desktop} route={route} />
      <header className="member-profile-brand">
        <Brand />
      </header>
      <main ref={fit.frame} className="member-profile-main">
        <section
          ref={fit.panel}
          className="member-profile-panel"
          aria-labelledby="member-profile-title"
        >
          {eyebrow}
          <h1 id="member-profile-title">{title}</h1>
          {children}
        </section>
      </main>
    </div>
  );
}
