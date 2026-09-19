export function Brand() {
  return (
    <span className="brand">
      <svg viewBox="0 0 28 28" aria-hidden="true">
        <path
          fill="currentColor"
          d="M3 3h9C20 3 25 7.5 25 14s-5 11-13 11H3v-7h6v2h3c4.5 0 7-2.2 7-6s-2.5-6-7-6H9v6H3V3Z"
        />
      </svg>
      <span>Dispatch</span>
    </span>
  );
}

// Preserve the archived name-based initials and color selection.
export function DspAvatar({ name }: { name: string }) {
  const words = name.toLocaleUpperCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
  const initials =
    words.length > 1
      ? `${[...words[0]!][0]}${[...words[1]!][0]}`
      : [...(words[0] || '?')].slice(0, 2).join('');
  const tone =
    [...words.join(' ')].reduce((hash, ch) => (hash * 31 + ch.codePointAt(0)!) >>> 0, 0) % 5;
  return (
    <span aria-hidden="true" className={`dsp-avatar tone-${tone}`}>
      {initials}
    </span>
  );
}
