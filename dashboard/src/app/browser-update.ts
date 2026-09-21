import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { onActivity } from './activity.js';

const storageKey = 'dispatch:browser-update:v1';
const values = new Map<string, unknown>();
let restored: Record<string, unknown> = {};
let position: { x: number; y: number; hash: string } | undefined;
try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
  sessionStorage.removeItem(storageKey);
  if (saved && Date.now() - saved.at < 60_000 && saved.hash === location.hash) {
    restored = saved.values;
    position = saved;
  }
} catch {
  // Restricted storage must not break the application.
}

// Only explicitly opted-in, non-sensitive navigation state is retained.
export function useUpdateState<T>(
  name: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const key = `${location.hash}:${name}`;
  const [value, setValue] = useState<T>(() => {
    const saved = restored[key];
    delete restored[key];
    return saved !== undefined
      ? (saved as T)
      : typeof initial === 'function'
        ? (initial as () => T)()
        : initial;
  });
  useEffect(() => {
    values.set(key, value);
    return () => {
      values.delete(key);
    };
  }, [key, value]);
  return [value, setValue];
}

let writes = 0;
export function beginBrowserWrite() {
  writes++;
  return () => {
    writes--;
  };
}

export function useBrowserUpdate(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const build = document.querySelector<HTMLMetaElement>('meta[name="dispatch-build"]')?.content;
    if (!build) return; // Vite development sessions use HMR.
    let lastActivity = performance.now();
    let candidate: string | undefined;
    let checkedAt = 0;
    let checking = false;
    let stopped = false;
    let reloading = false;
    const controller = new AbortController();
    const activity = () => {
      lastActivity = performance.now();
    };
    const unwatch = onActivity(activity);
    const blocked = () =>
      document.hidden ||
      writes > 0 ||
      Boolean(
        document.querySelector(
          'form, [role="dialog"], [aria-busy="true"], [contenteditable="true"]',
        ),
      );
    const check = async () => {
      if (checking || stopped || document.hidden) return;
      checking = true;
      try {
        const response = await fetch('/api/browser-update', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('Update check unavailable');
        const next = await response.json();
        if (stopped) return;
        candidate =
          next.ready === true &&
          typeof next.build === 'string' &&
          /^[a-f0-9]{64}$/.test(next.build) &&
          next.build !== build
            ? next.build
            : undefined;
        checkedAt = performance.now();
      } catch {
        candidate = undefined; // An unreachable or restarting server is never a reload signal.
      } finally {
        checking = false;
      }
    };
    const tick = () => {
      if (!candidate || reloading || blocked() || performance.now() - lastActivity < 2000) return;
      if (performance.now() - checkedAt > 1500) {
        void check();
        return;
      }
      try {
        const guardKey = 'dispatch:browser-update:last';
        const last = JSON.parse(sessionStorage.getItem(guardKey) || 'null');
        if (last?.build === candidate && Date.now() - last.at < 300_000) return;
        sessionStorage.setItem(guardKey, JSON.stringify({ build: candidate, at: Date.now() }));
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            at: Date.now(),
            hash: location.hash,
            x: scrollX,
            y: scrollY,
            values: Object.fromEntries(values),
          }),
        );
      } catch {
        // Without storage we cannot protect navigation state or prevent reload loops.
        return;
      }
      reloading = true;
      location.reload();
    };
    const visible = () => {
      activity();
      if (!document.hidden) void check();
    };
    document.addEventListener('visibilitychange', visible);
    const polling = window.setInterval(() => void check(), 5000);
    const idle = window.setInterval(tick, 100);
    void check();
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(polling);
      clearInterval(idle);
      unwatch();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !position) return;
    const saved = position;
    position = undefined;
    const deadline = performance.now() + 10_000;
    const restore = () => {
      if (location.hash !== saved.hash || performance.now() > deadline) {
        clearInterval(timer);
        return;
      }
      if (document.documentElement.scrollHeight >= saved.y + innerHeight) {
        window.scrollTo(saved.x, saved.y);
        clearInterval(timer);
      }
    };
    const timer = window.setInterval(restore, 100);
    const cancel = () => clearInterval(timer);
    const cancelEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    for (const event of cancelEvents)
      window.addEventListener(event, cancel, { once: true, passive: true });
    return () => {
      clearInterval(timer);
      for (const event of cancelEvents) window.removeEventListener(event, cancel);
    };
  }, [enabled]);
}
