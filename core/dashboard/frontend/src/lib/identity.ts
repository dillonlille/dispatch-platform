// Use the display name consistently across the fleet API and recovery API,
// which expose different identifiers for the same DSP.
export function dspIdentity(name: string) {
  const words = name.toLocaleUpperCase("en-US").match(/[\p{L}\p{N}]+/gu) || [];
  const initials =
    words.length > 1
      ? `${[...words[0]!][0]}${[...words[1]!][0]}`
      : [...(words[0] || "?")].slice(0, 2).join("");
  const tone =
    [...words.join(" ")].reduce(
      (hash, ch) => (hash * 31 + ch.codePointAt(0)!) >>> 0,
      0,
    ) % 5;
  return { initials, className: `dsp-avatar tone-${tone}` };
}
