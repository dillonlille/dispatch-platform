/** Private artwork for member completion; Settings retains its own badge and physics. */
export function MemberLanyardStraps() {
  return (
    <svg className="member-lanyard-straps" width="240" height="96" aria-hidden="true">
      <defs>
        <pattern id="member-lanyard-weave" width="2" height="3" patternUnits="userSpaceOnUse">
          <rect width="2" height="1.4" fill="#000" opacity=".2" />
          <rect width="1" height="3" fill="#fff" opacity=".06" />
        </pattern>
        <linearGradient id="member-lanyard-drape" x1="0" x2="1">
          <stop offset="0" stopColor="#000" stopOpacity=".34" />
          <stop offset=".22" stopColor="#000" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".1" />
          <stop offset=".78" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".34" />
        </linearGradient>
      </defs>
      {[-1, 1].map((side) => (
        <g
          key={side}
          className="member-lanyard-strap"
          transform={`translate(120 96) rotate(${side * 32})`}
        >
          <rect className="member-lanyard-cloth" x="-17" y="-1800" width="34" height="1800" />
          <rect x="-17" y="-1800" width="34" height="1800" fill="url(#member-lanyard-weave)" />
          <rect x="-17" y="-1800" width="34" height="1800" fill="url(#member-lanyard-drape)" />
          <path d="M-13.5 0 V-1800 M13.5 0 V-1800" />
        </g>
      ))}
    </svg>
  );
}

export function MemberLanyardClip() {
  return (
    <svg className="member-lanyard-clip" width="48" height="72" viewBox="76 88 48 72" aria-hidden>
      <defs>
        <linearGradient id="member-lanyard-metal" x1="0" x2="1">
          <stop offset="0" stopColor="#8d97a8" />
          <stop offset=".35" stopColor="#e6ebf2" />
          <stop offset=".6" stopColor="#9aa4b4" />
          <stop offset="1" stopColor="#5f697a" />
        </linearGradient>
        {/* The hook fades out as it passes into the badge's slot. */}
        <linearGradient
          id="member-lanyard-into-slot"
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
          id="member-lanyard-hook-mask"
          maskUnits="userSpaceOnUse"
          x="80"
          y="88"
          width="40"
          height="72"
        >
          <rect x="76" y="88" width="48" height="72" fill="url(#member-lanyard-into-slot)" />
        </mask>
      </defs>
      <rect x="79" y="88" width="42" height="22" rx="3.5" fill="url(#member-lanyard-metal)" />
      <rect x="79" y="88" width="42" height="1.5" rx=".75" fill="#fff" opacity=".5" />
      <rect x="79" y="104" width="42" height="1.5" fill="#000" opacity=".22" />
      <circle cx="100" cy="97" r="3.2" fill="#000" opacity=".28" />
      <circle cx="100" cy="96.4" r="2.6" fill="url(#member-lanyard-metal)" />
      <circle
        cx="100"
        cy="115"
        r="5"
        fill="none"
        stroke="url(#member-lanyard-metal)"
        strokeWidth="3"
      />
      <path
        d="M100 120 c0 5 -5 7 -5 12 c0 9 5 11 5 25"
        fill="none"
        stroke="url(#member-lanyard-metal)"
        strokeWidth="4"
        mask="url(#member-lanyard-hook-mask)"
      />
    </svg>
  );
}
