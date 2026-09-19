export type Appearance = 'light' | 'dark' | 'system';
export function readAppearance(userId: string): Appearance {
  try {
    const value = localStorage.getItem(`dispatch-appearance:${userId}`);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
export function applyAppearance(mode: Appearance) {
  document.documentElement.dataset.theme =
    mode === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;
}
export function saveAppearance(userId: string, mode: Appearance) {
  let saved = true;
  try {
    localStorage.setItem(`dispatch-appearance:${userId}`, mode);
  } catch {
    saved = false;
  }
  applyAppearance(mode);
  window.dispatchEvent(new Event('dispatch-appearance'));
  return saved;
}
