import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Check } from 'lucide-react';
import { DspAvatar, dspTone } from '../../../ui/DspAvatar.js';
import { useViewportFit } from '../../../ui/useViewportFit.js';
import { MemberLanyardClip, MemberLanyardStraps } from './MemberProfileLanyard.js';
import { MEMBER_COMPLETION_MEDIA, MEMBER_COMPLETION_TIMING } from './member-completion-motion.js';
import './member-profile-completion.css';

export type MemberIdentity = {
  firstName: string;
  lastName: string;
  email: string;
  dspName: string;
  role: string;
};

export function MemberProfileCompletion({
  identity,
  scene,
  onComplete,
}: {
  identity: MemberIdentity;
  scene: RefObject<HTMLDivElement | null>;
  onComplete: (animate: boolean) => void;
}) {
  const fit = useViewportFit();
  const rig = useRef<HTMLDivElement>(null);
  const hang = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const media = matchMedia(MEMBER_COMPLETION_MEDIA);
    let finished = false;
    const finish = (animate = false) => {
      if (finished) return;
      finished = true;
      onComplete(animate);
    };
    if (!media.matches) {
      finish();
      return;
    }
    const { fade, drop, settle, lift } = MEMBER_COMPLETION_TIMING;
    const exitAt = fade + drop + settle;
    const animations: Animation[] = [];
    function animate(
      element: HTMLElement | null,
      frames: Keyframe[],
      duration: number,
      delay = 0,
      easing = 'ease-in-out',
    ) {
      const animation = element!.animate(frames, { duration, delay, easing, fill: 'forwards' });
      animations.push(animation);
      return animation;
    }
    // Composited transforms and opacity only; no React renders or layout reads per frame.
    animate(scene.current, [{ opacity: 1 }, { opacity: 0 }], fade, 0, 'ease-out');
    animate(
      rig.current,
      [
        { transform: 'translateY(calc(-100% - 100vh))', easing: 'cubic-bezier(.55,0,.85,.4)' },
        { transform: 'translateY(14px)', offset: 0.72, easing: 'ease-out' },
        { transform: 'translateY(-5px)', offset: 0.88, easing: 'ease-in-out' },
        { transform: 'translateY(0)' },
      ],
      drop,
      fade,
      'linear',
    );
    animate(
      hang.current,
      [
        { transform: 'rotate(7deg)' },
        { transform: 'rotate(-4deg)', offset: 0.35 },
        { transform: 'rotate(1.5deg)', offset: 0.7 },
        { transform: 'rotate(0deg)' },
      ],
      drop * 0.3 + settle,
      fade + drop * 0.7,
    );
    animate(
      sheen.current,
      [
        { transform: 'translateX(-70%)', opacity: 0 },
        { opacity: 0.8, offset: 0.4 },
        { transform: 'translateX(70%)', opacity: 0 },
      ],
      settle,
      fade + drop,
    );
    animate(
      badge.current,
      [
        { transform: 'translateY(0) rotate(0deg)' },
        { transform: 'translateY(12px) rotate(3deg)', offset: 0.3 },
        { transform: 'translateY(0) rotate(-2deg)' },
      ],
      lift,
      exitAt,
    );
    const exit = animate(
      rig.current,
      [{ transform: 'translateY(0)' }, { transform: 'translateY(calc(-100% - 100vh))' }],
      lift,
      exitAt,
      'cubic-bezier(.65,0,.8,.4)',
    );
    void exit.finished.then(
      () => finish(true),
      () => {},
    );
    // Do not trap a saved profile if the tab is suspended or the viewport changes.
    const timer = window.setTimeout(() => finish(true), exitAt + lift + 150);
    const changed = () => {
      if (!media.matches || document.hidden) finish();
    };
    media.addEventListener('change', changed);
    document.addEventListener('visibilitychange', changed);
    changed();
    return () => {
      finished = true;
      clearTimeout(timer);
      media.removeEventListener('change', changed);
      document.removeEventListener('visibilitychange', changed);
      animations.forEach((animation) => animation.cancel());
    };
  }, [onComplete, scene]);
  return (
    <main ref={fit.frame} className="member-completion" role="status" aria-label="Profile created">
      <span className="sr-only">Profile created. Taking you to Sign In.</span>
      <section ref={fit.panel} className="member-completion-size" aria-label="Your member badge">
        <div ref={rig} className="member-completion-rig">
          <MemberLanyardStraps />
          <div ref={hang} className="member-completion-hang">
            <MemberLanyardClip />
            <div ref={badge} className={`member-completion-badge ${dspTone(identity.dspName)}`}>
              <span className="member-completion-punch" />
              <h2>
                <span>{identity.firstName}</span>
                <span>{identity.lastName}</span>
              </h2>
              <p className="member-completion-email">{identity.email}</p>
              <span className="member-completion-role">{identity.role}</span>
              <div className="member-completion-confirmed">
                <Check size={16} aria-hidden="true" />
                Profile created
              </div>
              <div className="member-completion-org">
                <DspAvatar name={identity.dspName} />
                {identity.dspName}
              </div>
              <span ref={sheen} className="member-completion-sheen" aria-hidden="true" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
