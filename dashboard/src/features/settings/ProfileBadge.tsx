import { useEffect, useRef, type PointerEvent, type RefObject } from 'react';
import type { DspView, SessionView } from '../../../../shared/contracts/index.js';
import { timezoneName } from '../../lib/format.js';
import { Badge } from '../../ui/index.js';
import { DspAvatar, dspTone } from '../platform/DspAvatar.js';

// The badge leans toward a mouse pointer. CSS variables carry the tilt so moving it never re-renders.
function tilt(event: PointerEvent<HTMLElement>) {
  if (event.pointerType !== 'mouse' || event.buttons) return;
  const badge = event.currentTarget;
  const box = badge.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width - 0.5;
  const y = (event.clientY - box.top) / box.height - 0.5;
  badge.style.setProperty('--tilt-y', `${x * 10}deg`);
  badge.style.setProperty('--tilt-x', `${-y * 8}deg`);
  badge.style.setProperty('--sheen', `${x * 60}%`);
}
function settle(badge: HTMLElement) {
  for (const name of ['--tilt-x', '--tilt-y', '--sheen']) badge.style.removeProperty(name);
}

/*
 * The clip is a damped pendulum on the strap, whose two ends stay where they are anchored above the
 * page, and the badge a second, stiffer one about its hook, pushed the other way by the clip's
 * acceleration so that it lags and then catches up.
 * Dragging the badge pulls the strap toward the pointer; letting go keeps the velocity it had.
 * Angles are radians, clockwise positive, written to CSS variables so that nothing re-renders.
 */
const GRAVITY = 15; // g / length: a swing of about 1.6 seconds
const AIR = 1.1;
const PULL = 90; // how hard a drag draws the strap to the pointer
const PULL_DAMPING = 14;
const HOOK_STIFFNESS = 70;
const HOOK_DAMPING = 7;
const HOOK_LAG = 0.55;
const LIMIT = 0.5;
const REST = 0.0004;
const STRAP = 92; // from the anchors down to the clip, in the lanyard's own pixels
const CENTRE = 120;
const SPREAD = 72; // each strap is anchored this far to the side of the clip's resting place
const STRAP_LENGTH = Math.hypot(SPREAD, STRAP);

// Each strap is drawn running straight up from the clip at (x, y), then turned to pass through its anchor.
// It is never stretched: more or less of its length shows below the tab rule, as cloth would slide.
function strapTransform(side: -1 | 1, x: number, y: number) {
  const turn = (Math.atan2(side * SPREAD - x, STRAP + y) * 180) / Math.PI;
  return `translate(${CENTRE + x} ${STRAP + y}) rotate(${turn})`;
}

function usePendulum() {
  const straps = useRef<SVGSVGElement>(null);
  const hang = useRef<HTMLDivElement>(null);
  const badge = useRef<HTMLElement>(null);
  const grab = useRef<(event: PointerEvent<HTMLElement>) => void>(() => {});
  useEffect(() => {
    const strapsEl = straps.current;
    const hangEl = hang.current;
    const badgeEl = badge.current;
    if (!strapsEl || !hangEl || !badgeEl || matchMedia('(prefers-reduced-motion: reduce)').matches)
      return;
    // It starts held to one side, as if just let go.
    let swing = 0.13;
    let swingSpeed = 0;
    let sway = 0;
    let swaySpeed = 0;
    let target: number | null = null;
    let frame = 0;
    let last = 0;
    // The right strap is drawn first, so that the left one lies over it at the clip.
    const [right, left] = [...strapsEl.querySelectorAll('.profile-strap')];
    const draw = () => {
      const x = -STRAP * Math.sin(swing);
      const y = STRAP * Math.cos(swing) - STRAP;
      left!.setAttribute('transform', strapTransform(-1, x, y));
      right!.setAttribute('transform', strapTransform(1, x, y));
      hangEl.style.transform = `translate(${x}px, ${y}px) rotate(${swing}rad)`;
      badgeEl.style.setProperty('--sway', `${sway}rad`);
    };
    const step = (now: number) => {
      // Fixed small steps keep the integration stable after a slow frame or a background tab.
      let remaining = Math.min((now - last) / 1000, 0.05);
      last = now;
      while (remaining > 0) {
        const dt = Math.min(remaining, 0.004);
        remaining -= dt;
        const acceleration =
          target === null
            ? -GRAVITY * Math.sin(swing) - AIR * swingSpeed
            : PULL * (target - swing) - PULL_DAMPING * swingSpeed;
        swingSpeed += acceleration * dt;
        swing += swingSpeed * dt;
        if (Math.abs(swing) > LIMIT) {
          swing = Math.sign(swing) * LIMIT;
          swingSpeed *= -0.3;
        }
        swaySpeed +=
          (-HOOK_STIFFNESS * sway - HOOK_DAMPING * swaySpeed - HOOK_LAG * acceleration) * dt;
        sway += swaySpeed * dt;
      }
      draw();
      const energy = swing * swing + swingSpeed * swingSpeed + sway * sway + swaySpeed * swaySpeed;
      if (target === null && energy < REST) {
        frame = 0;
        swing = swingSpeed = sway = swaySpeed = 0;
        draw();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    const wake = () => {
      if (frame) return;
      last = performance.now();
      frame = requestAnimationFrame(step);
    };
    const aim = (event: { clientX: number; clientY: number }) => {
      const box = strapsEl.getBoundingClientRect();
      const pivotX = box.left + box.width / 2;
      const angle = Math.atan2(pivotX - event.clientX, Math.max(event.clientY - box.top, 40));
      target = Math.max(-LIMIT, Math.min(LIMIT, angle));
    };
    const move = (event: globalThis.PointerEvent) => aim(event);
    const release = () => {
      target = null;
      badgeEl.classList.remove('held');
      badgeEl.removeEventListener('pointermove', move);
    };
    grab.current = (event) => {
      if (event.button !== 0) return;
      badgeEl.setPointerCapture(event.pointerId);
      badgeEl.classList.add('held');
      settle(badgeEl);
      aim(event);
      badgeEl.addEventListener('pointermove', move);
      wake();
    };
    badgeEl.addEventListener('pointerup', release);
    badgeEl.addEventListener('pointercancel', release);
    wake();
    return () => {
      cancelAnimationFrame(frame);
      release();
      badgeEl.removeEventListener('pointerup', release);
      badgeEl.removeEventListener('pointercancel', release);
    };
  }, []);
  return { straps, hang, badge, grab };
}

const CLOTH = { x: -17, y: -STRAP_LENGTH - 90, width: 34, height: STRAP_LENGTH + 90 };
function Strap({ side }: { side: -1 | 1 }) {
  return (
    <g className="profile-strap" transform={strapTransform(side, 0, 0)}>
      <rect className="profile-strap-cloth" {...CLOTH} />
      <rect {...CLOTH} fill="url(#profile-weave)" />
      <rect {...CLOTH} fill="url(#profile-drape)" />
      <path d={`M-13.5 0 V${CLOTH.y} M13.5 0 V${CLOTH.y}`} />
    </g>
  );
}
function Straps({ svg }: { svg: RefObject<SVGSVGElement | null> }) {
  return (
    <svg className="profile-straps" ref={svg} width={CENTRE * 2} height="96" aria-hidden>
      <defs>
        {/* Ribs across the strap, with finer threads along it. */}
        <pattern id="profile-weave" width="2" height="3" patternUnits="userSpaceOnUse">
          <rect width="2" height="1.4" fill="#000" opacity=".2" />
          <rect width="1" height="3" fill="#fff" opacity=".06" />
        </pattern>
        {/* Cloth curls slightly away at its edges. */}
        <linearGradient id="profile-drape" x1="0" x2="1">
          <stop offset="0" stopColor="#000" stopOpacity=".34" />
          <stop offset=".22" stopColor="#000" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".1" />
          <stop offset=".78" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".34" />
        </linearGradient>
      </defs>
      <Strap side={1} />
      <Strap side={-1} />
    </svg>
  );
}
function Clip() {
  return (
    <svg className="profile-clip" width="48" height="72" viewBox="76 88 48 72" aria-hidden>
      <defs>
        <linearGradient id="profile-metal" x1="0" x2="1">
          <stop offset="0" stopColor="#8d97a8" />
          <stop offset=".35" stopColor="#e6ebf2" />
          <stop offset=".6" stopColor="#9aa4b4" />
          <stop offset="1" stopColor="#5f697a" />
        </linearGradient>
        {/* The hook fades out as it passes into the badge's slot. */}
        <linearGradient
          id="profile-into-slot"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="148"
          x2="0"
          y2="158"
        >
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
        <mask
          id="profile-hook-mask"
          maskUnits="userSpaceOnUse"
          x="80"
          y="88"
          width="40"
          height="72"
        >
          <rect x="76" y="88" width="48" height="72" fill="url(#profile-into-slot)" />
        </mask>
      </defs>
      <rect x="79" y="88" width="42" height="22" rx="3.5" fill="url(#profile-metal)" />
      <rect x="79" y="88" width="42" height="1.5" rx=".75" fill="#fff" opacity=".5" />
      <rect x="79" y="104" width="42" height="1.5" fill="#000" opacity=".22" />
      <circle cx="100" cy="97" r="3.2" fill="#000" opacity=".28" />
      <circle cx="100" cy="96.4" r="2.6" fill="url(#profile-metal)" />
      <circle cx="100" cy="115" r="5" fill="none" stroke="url(#profile-metal)" strokeWidth="3" />
      <path
        d="M100 120 c0 5 -5 7 -5 12 c0 9 5 11 5 25"
        fill="none"
        stroke="url(#profile-metal)"
        strokeWidth="4"
        mask="url(#profile-hook-mask)"
      />
    </svg>
  );
}

export function ProfileBadge({ session, view }: { session: SessionView; view?: DspView }) {
  const { user } = session;
  const { straps, hang, badge, grab } = usePendulum();
  const role = user.platformOwner ? 'Platform owner' : (view?.role.name ?? 'Team member');
  return (
    <div className="profile-stage">
      <div className="profile-rig">
        <Straps svg={straps} />
        <div className="profile-hang" ref={hang}>
          <Clip />
          <section
            className={`profile-badge ${view ? dspTone(view.dsp.name) : ''}`}
            ref={badge}
            onPointerDown={(event) => grab.current(event)}
            onPointerMove={tilt}
            onPointerLeave={(event) => settle(event.currentTarget)}
          >
            <span className="profile-punch" />
            <h2>
              <span>{user.firstName}</span> <span>{user.lastName}</span>
            </h2>
            <p className="profile-email">{user.email}</p>
            <span className="role-badge">{role}</span>
            {view && (
              <>
                <dl className="profile-facts">
                  <div>
                    <dt>Station</dt>
                    <dd className="profile-station">{view.profile?.stationCode || '—'}</dd>
                  </div>
                  <div>
                    <dt>Business timezone</dt>
                    <dd>
                      {timezoneName(view.dsp.timezone)}
                      <small>{view.dsp.timezone}</small>
                    </dd>
                  </div>
                  {view.role.name !== role && (
                    <div>
                      <dt>Viewing as</dt>
                      <dd>{view.role.name}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <Badge value={view.dsp.status} />
                    </dd>
                  </div>
                </dl>
                <div className="profile-org">
                  <DspAvatar name={view.dsp.name} />
                  {view.dsp.name}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
