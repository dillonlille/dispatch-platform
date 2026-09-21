import { useEffect, useRef, useState } from 'react';
import posterUrl from './assets/login-van-poster.png?url';

/** Mounted only on desktop. The form paints before any graphics code loads. */
export function LoginVan() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    const element = canvas.current!;
    const timer = window.setTimeout(() => {
      void import('./van/renderer.js')
        .then(({ startVan }) => {
          if (!abort.signal.aborted) return startVan(element, abort.signal, setReady);
        })
        .catch(() => {
          if (!abort.signal.aborted) setReady(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, []);
  return (
    <div className="login-van">
      <img src={posterUrl} alt="" hidden={ready} decoding="async" />
      <canvas ref={canvas} style={{ visibility: ready ? 'visible' : 'hidden' }} />
    </div>
  );
}
