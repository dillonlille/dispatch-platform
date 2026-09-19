import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import type { BrowserFrame, BrowserInput } from '../../../../shared/browser.js';
import { api, ApiError } from '../../app/api.js';
import { ErrorBox, Loading, Modal } from '../../ui/index.js';
import { messageOf } from '../../lib/errors.js';
import { connectionUrl } from '../../app/endpoints.js';

export function BrowserVerification({
  sessionId,
  close,
  provider = 'paycom',
}: {
  sessionId: string;
  provider?: 'paycom' | 'cortex';
  close: () => void;
}) {
  const name = provider === 'paycom' ? 'Paycom' : 'Cortex';
  const endpoint = connectionUrl(provider);
  const [frame, setFrame] = useState<BrowserFrame>();
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [text, setText] = useState('');
  const image = useRef<HTMLImageElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const capturing = useRef(false);
  const pressed = useRef(false);
  const blocked = useRef(false);
  const move = useRef<Extract<BrowserInput, { kind: 'pointer' }> | undefined>(undefined);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  blocked.current = busy || expired;

  const failed = useCallback((error: Error) => {
    if (controller.current?.signal.aborted || error.name === 'AbortError') return;
    setError(messageOf(error));
    if (
      error instanceof ApiError &&
      ['verification_expired', 'permission_denied'].includes(error.code)
    ) {
      setExpired(true);
      blocked.current = true;
    }
  }, []);
  const capture = useCallback(async () => {
    if (capturing.current || blocked.current || controller.current?.signal.aborted) return;
    capturing.current = true;
    const signal = controller.current?.signal;
    try {
      const next = await api<BrowserFrame>(
        `${endpoint}/screenshot?sessionId=${encodeURIComponent(sessionId)}`,
        undefined,
        signal,
      );
      if (signal?.aborted) return;
      if (next.sessionId !== sessionId)
        throw new ApiError('verification_expired', 'This verification session has ended.', 409);
      setFrame(next);
      setStreamError('');
    } catch (error) {
      if (!signal?.aborted && (error as Error).name !== 'AbortError') {
        setStreamError(messageOf(error));
        if (error instanceof ApiError && [401, 403, 409].includes(error.status)) failed(error);
      }
    } finally {
      capturing.current = false;
    }
  }, [sessionId, failed, endpoint]);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await capture();
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 650);
    };
    void poll();
    const viewport = screen.current;
    const preventPageScroll = (event: WheelEvent) => {
      if (event.target === image.current) event.preventDefault();
    };
    viewport?.addEventListener('wheel', preventPageScroll, { passive: false });
    return () => {
      abort.abort();
      clearTimeout(timer);
      clearTimeout(moveTimer.current);
      viewport?.removeEventListener('wheel', preventPageScroll);
    };
  }, [capture]);
  useEffect(() => {
    if (zoom && screen.current) {
      screen.current.scrollLeft = (screen.current.scrollWidth - screen.current.clientWidth) / 2;
      screen.current.scrollTop = Math.max(
        0,
        (screen.current.scrollHeight - screen.current.clientHeight) / 2,
      );
    }
  }, [zoom]);
  const send = (input: BrowserInput) => {
    if (blocked.current || controller.current?.signal.aborted) return;
    pending.current = pending.current
      .then(async () => {
        if (controller.current?.signal.aborted) return;
        await api(`${endpoint}/assist`, { sessionId, input }, controller.current?.signal);
      })
      .catch(failed);
  };
  const position = (element: HTMLImageElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          element.naturalWidth - 1,
          ((clientX - rect.left) * element.naturalWidth) / rect.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          element.naturalHeight - 1,
          ((clientY - rect.top) * element.naturalHeight) / rect.height,
        ),
      ),
    };
  };
  const flushMove = () => {
    clearTimeout(moveTimer.current);
    moveTimer.current = undefined;
    if (move.current) {
      send(move.current);
      move.current = undefined;
    }
  };
  const release = (event: PointerEvent<HTMLImageElement>) => {
    if (!pressed.current) return;
    flushMove();
    pressed.current = false;
    send({
      kind: 'pointer',
      phase: 'up',
      pressed: false,
      ...position(event.currentTarget, event.clientX, event.clientY),
    });
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const submit = async () => {
    flushMove();
    blocked.current = true;
    setBusy(true);
    setError('');
    try {
      await pending.current;
      if (controller.current?.signal.aborted) return;
      await api(`${endpoint}/submit`, { sessionId }, controller.current?.signal);
      close();
    } catch (error) {
      failed(error as Error);
    } finally {
      if (!controller.current?.signal.aborted) {
        setBusy(false);
        blocked.current = false;
      }
    }
  };
  return (
    <Modal title={`Complete ${name} verification`} variant="browser" onClose={close}>
      <p className="verification-instructions">
        Complete the verification requested in the window below, then click Submit to continue
        signing in.
      </p>
      <div className="verification-toolbar">
        <span className="muted" role="status">
          {busy
            ? 'Continuing login…'
            : expired
              ? 'Session ended'
              : streamError
                ? 'Reconnecting…'
                : `Live ${name} window`}
        </span>
        <div>
          <button
            type="button"
            disabled={!frame || busy}
            onClick={() => setZoom((value) => !value)}
          >
            {zoom ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            {zoom ? 'Fit window' : 'Zoom in'}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh browser window"
            disabled={busy || expired}
            onClick={() => void capture()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div ref={screen} className={`verification-screen ${zoom ? 'zoomed' : ''}`} aria-busy={busy}>
        {!frame ? (
          <Loading />
        ) : (
          <img
            ref={image}
            className="verification-browser"
            alt={`Interactive ${name} verification browser`}
            tabIndex={busy || expired ? -1 : 0}
            role="application"
            aria-label={`${name} verification browser`}
            aria-describedby="verification-keyboard-help"
            draggable={false}
            src={`data:image/png;base64,${frame.image}`}
            onLoad={() => {
              if (zoom && screen.current && !pressed.current && screen.current.scrollLeft === 0)
                screen.current.scrollLeft =
                  (screen.current.scrollWidth - screen.current.clientWidth) / 2;
            }}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (blocked.current || event.button !== 0 || !event.isPrimary) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              flushMove();
              pressed.current = true;
              send({
                kind: 'pointer',
                phase: 'down',
                pressed: true,
                ...position(event.currentTarget, event.clientX, event.clientY),
              });
            }}
            onPointerMove={(event) => {
              if (blocked.current || !event.isPrimary) return;
              move.current = {
                kind: 'pointer',
                phase: 'move',
                pressed: pressed.current,
                ...position(event.currentTarget, event.clientX, event.clientY),
              };
              if (!moveTimer.current)
                moveTimer.current = setTimeout(() => {
                  const scheduled = moveTimer.current;
                  // Keep the latest position while earlier input is in flight.
                  // A slow connection must not accumulate a trail of old moves.
                  void pending.current.then(() => {
                    if (moveTimer.current === scheduled) flushMove();
                  });
                }, 60);
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onWheel={(event) => {
              if (blocked.current) return;
              const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 500 : 1;
              send({
                kind: 'scroll',
                ...position(event.currentTarget, event.clientX, event.clientY),
                deltaX: Math.max(-2000, Math.min(2000, event.deltaX * scale)),
                deltaY: Math.max(-2000, Math.min(2000, event.deltaY * scale)),
              });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                submitButton.current?.focus();
                return;
              }
              if (blocked.current || event.ctrlKey || event.metaKey || event.altKey) return;
              if (event.key.length === 1) {
                event.preventDefault();
                event.stopPropagation();
                send({ kind: 'type', text: event.key });
              } else if (
                [
                  'Enter',
                  'Tab',
                  'Backspace',
                  'Delete',
                  'ArrowDown',
                  'ArrowUp',
                  'ArrowLeft',
                  'ArrowRight',
                  'Home',
                  'End',
                  'PageUp',
                  'PageDown',
                ].includes(event.key)
              ) {
                event.preventDefault();
                event.stopPropagation();
                send({
                  kind: 'key',
                  key: event.key as Extract<BrowserInput, { kind: 'key' }>['key'],
                  shift: event.shiftKey,
                });
              }
            }}
            onPaste={(event) => {
              event.preventDefault();
              const value = event.clipboardData.getData('text');
              if (value) send({ kind: 'type', text: value.slice(0, 256) });
            }}
          />
        )}
      </div>
      <div className="verification-footer">
        <p id="verification-keyboard-help" className="muted">
          Click, drag, scroll, or type in the window. Press Escape to return to these controls.
        </p>
        <form
          className="verification-text"
          onSubmit={(event) => {
            event.preventDefault();
            if (text) {
              send({ kind: 'type', text });
              setText('');
            }
          }}
        >
          <input
            aria-label={`Text to type in ${name}`}
            placeholder="Text to type in the selected field"
            value={text}
            maxLength={256}
            autoComplete="off"
            disabled={busy || expired || !frame}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" disabled={busy || expired || !text}>
            Type
          </button>
        </form>
        <ErrorBox message={error || streamError} />
        <div className="form-actions">
          <button type="button" onClick={close}>
            Close
          </button>
          <button
            ref={submitButton}
            type="button"
            className="primary"
            disabled={busy || expired || !frame}
            onClick={() => void submit()}
          >
            {busy ? 'Continuing…' : 'Submit'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
