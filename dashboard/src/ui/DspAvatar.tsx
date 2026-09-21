const nameWords = (name: string) => name.toLocaleUpperCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
/** The identity tone class a DSP's name selects, shared by its avatar and its profile badge. */
export const dspTone = (name: string) =>
  `tone-${[...nameWords(name).join(' ')].reduce((hash, ch) => (hash * 31 + ch.codePointAt(0)!) >>> 0, 0) % 5}`;
// Preserve the archived name-based initials and color selection.
export function DspAvatar({ name }: { name: string }) {
  const words = nameWords(name);
  const initials =
    words.length > 1
      ? `${[...words[0]!][0]}${[...words[1]!][0]}`
      : [...(words[0] || '?')].slice(0, 2).join('');
  return (
    <span aria-hidden="true" className={`dsp-avatar ${dspTone(name)}`}>
      {initials}
    </span>
  );
}
