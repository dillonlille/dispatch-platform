import type { ReactNode } from 'react';
import { Brand } from '../../../app/Brand.js';
import { useViewportFit } from '../../../ui/useViewportFit.js';
import { MemberProfileMap } from './MemberProfileMap.js';
import { useMemberProfileMap } from './member-profile-map-asset.js';
import './member-profile.css';

export function MemberProfileLayout({ children }: { children: ReactNode }) {
  const fit = useViewportFit();
  const { desktop, ready } = useMemberProfileMap();
  return (
    <div className="member-profile-page" data-ready={ready} aria-busy={!ready}>
      <MemberProfileMap desktop={desktop} />
      <header className="member-profile-brand">
        <Brand />
      </header>
      <main ref={fit.frame} className="member-profile-main">
        <section
          ref={fit.panel}
          className="member-profile-panel"
          aria-labelledby="member-profile-title"
        >
          <h1 id="member-profile-title">Create your profile</h1>
          {children}
        </section>
      </main>
    </div>
  );
}
