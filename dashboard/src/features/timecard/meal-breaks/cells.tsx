import { AlertTriangle } from 'lucide-react';
import type { ClockTime, DeliveryGap } from '../../../../../shared/meal-breaks.js';

export function Source({ name }: { name: 'Paycom' | 'Flex' }) {
  return (
    <span className={`meal-source ${name.toLowerCase()}`}>
      <i aria-hidden="true" />
      {name}
    </span>
  );
}
export function Clock({
  value,
  difference,
}: {
  value?: ClockTime | null;
  difference?: number | null;
}) {
  return (
    <span className={`meal-clock${difference ? ' different' : ''}`} title={value?.detail}>
      {value ? (
        <>
          {value.label}
          {value.day !== 0 && (
            <small>
              {' '}
              ({value.day > 0 ? '+' : ''}
              {value.day}d)
            </small>
          )}
        </>
      ) : (
        <span className="meal-missing" aria-label="Not available">
          —
        </span>
      )}
      {difference !== undefined && difference !== null && difference !== 0 && (
        <small className="meal-delta">
          {difference > 0 ? '+' : '−'}
          {Math.abs(difference)}m
        </small>
      )}
    </span>
  );
}
export function LunchCell({
  paycom,
  cortex,
  difference,
}: {
  paycom?: ClockTime | null;
  cortex?: ClockTime | null;
  difference?: number | null;
}) {
  return (
    <>
      <div>
        <Source name="Paycom" />
        <Clock value={paycom} />
      </div>
      <div>
        <Source name="Flex" />
        <Clock value={cortex} difference={difference} />
      </div>
    </>
  );
}
export function GapBadge({ gap, side }: { gap: DeliveryGap | null; side: 'before' | 'after' }) {
  const endpoints =
    side === 'before' ? 'Last delivery → Flex OUT LUNCH' : 'Flex IN LUNCH → first delivery';
  const detail = `${endpoints}: ${gap ? `${gap.label}${gap.overLimit ? ' · over 5 minutes' : ''}` : 'gap unavailable'}`;
  return (
    <span
      className={`meal-gap${gap?.overLimit ? ' over-limit' : ''}`}
      title={detail}
      aria-label={detail}
    >
      {gap?.overLimit && <AlertTriangle size={14} aria-hidden="true" />}
      <span>
        {gap ? (
          <>
            <span className="meal-gap-duration">{gap.label}</span> {side} lunch
          </>
        ) : (
          'Gap unavailable'
        )}
      </span>
    </span>
  );
}
