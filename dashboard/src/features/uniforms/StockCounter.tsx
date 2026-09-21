import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { UniformAdjustment, UniformVariant } from '../../../../shared/contracts/uniforms.js';
import { uniformFitLabels } from '../../../../shared/contracts/uniforms.js';
import { ApiError, view } from '../../app/api.js';
import { adjustUniform } from '../../app/endpoints.js';
import { useAction } from '../../app/useAction.js';
import { randomId } from '../../lib/random-id.js';

export function StockCounter({
  variant,
  uniformName,
  canAdjust,
  live,
  onChange,
  refresh,
}: {
  variant: UniformVariant;
  uniformName: string;
  canAdjust: boolean;
  live: boolean;
  onChange: (change: UniformAdjustment) => void;
  refresh: () => void;
}) {
  const [pending, setPending] = useState(0);
  const action = useAction(async (delta: 1 | -1) => {
    const requestId = randomId();
    const token = view;
    setPending((n) => n + 1);
    try {
      for (let attempt = 0; ; attempt++) {
        if (view !== token) return;
        try {
          const result = await adjustUniform(
            variant.id,
            delta,
            requestId,
            AbortSignal.timeout(10_000),
          );
          if (view === token) onChange(result);
          return;
        } catch (cause) {
          // A lost acknowledgement may already have committed. Retry the same operation, never another delta.
          if (
            attempt >= 2 ||
            (cause instanceof ApiError && cause.status < 500 && cause.status !== 429)
          )
            throw cause;
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    } catch (cause) {
      if (view === token) refresh();
      throw cause;
    } finally {
      setPending((n) => n - 1);
    }
  });
  const label = `${uniformName}, ${uniformFitLabels[variant.fit]}, ${variant.size}`;
  return (
    <div className="uniform-counter" aria-busy={pending > 0}>
      {canAdjust && (
        <button
          type="button"
          aria-label={`Remove one ${label}`}
          disabled={!live || variant.quantity === 0}
          onClick={() => void action.run(-1)}
        >
          <Minus size={14} />
        </button>
      )}
      <output aria-label={`${label} in stock`}>{live ? variant.quantity : '—'}</output>
      {canAdjust && (
        <button
          type="button"
          aria-label={`Add one ${label}`}
          disabled={!live || variant.quantity >= 1_000_000}
          onClick={() => void action.run(1)}
        >
          <Plus size={14} />
        </button>
      )}
      {pending > 0 && (
        <span className="sr-only" role="status">
          Saving inventory
        </span>
      )}
    </div>
  );
}
