export type Appearance = 'light' | 'dark' | 'system';
const signedOut = 'signed-out';

export function readAppearance(userId: string): Appearance {
  try {
    const value = localStorage.getItem(`dispatch-appearance:${userId}`);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
function storeAppearance(userId: string, mode: Appearance) {
  try {
    localStorage.setItem(`dispatch-appearance:${userId}`, mode);
    return true;
  } catch {
    return false;
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
/** Keep the account's choice for sign-in; a screen override never replaces it. */
export function restoreAppearance(userId?: string, override?: Appearance) {
  const preference = readAppearance(userId ?? signedOut);
  if (userId) storeAppearance(signedOut, preference);
  applyAppearance(override ?? preference);
}
export function saveAppearance(userId: string, mode: Appearance) {
  const saved = storeAppearance(userId, mode);
  applyAppearance(mode);
  window.dispatchEvent(new Event('dispatch-appearance'));
  return saved;
}
