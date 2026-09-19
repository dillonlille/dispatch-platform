import type { Timecard } from '../../../../shared/contracts/index.js';
import { paycomColumns, type PaycomColumn } from '../../../../shared/paycom.js';
import { Badge } from '../../ui/index.js';

export function PunchCells({ card }: { card: Timecard }) {
  const values: Record<PaycomColumn, string> = {
    inDay: card.punches[0]?.in ?? '—',
    outLunch:
      card.punches.length > 1
        ? card.punches
            .slice(0, -1)
            .map((p) => p.out ?? '—')
            .join(', ')
        : '—',
    inLunch:
      card.punches.length > 1
        ? card.punches
            .slice(1)
            .map((p) => p.in ?? '—')
            .join(', ')
        : '—',
    outDay: card.punches.at(-1)?.out ?? '—',
    totalHours: card.hours.toFixed(2),
    condition: card.status,
  };
  return (
    <>
      {paycomColumns.map(([key]) => (
        <td key={key}>
          {key === 'condition' ? (
            <Badge value={card.status.toLowerCase() === 'complete' ? 'ready' : 'pending'}>
              {card.status}
            </Badge>
          ) : (
            values[key]
          )}
        </td>
      ))}
    </>
  );
}
