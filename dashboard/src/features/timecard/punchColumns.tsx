import type { Timecard } from '../../../../shared/contracts/index.js';
import { paycomColumns, type PaycomColumn } from '../../lib/paycom.js';
import { Badge, type TableColumn } from '../../ui/index.js';

const punches = (card: Timecard, values: (string | null)[]) =>
  card.punches.length > 1 ? values.map((value) => value ?? '—').join(', ') : '—';
const values: Record<PaycomColumn, (card: Timecard) => string> = {
  inDay: (card) => card.punches[0]?.in ?? '—',
  outLunch: (card) =>
    punches(
      card,
      card.punches.slice(0, -1).map((punch) => punch.out),
    ),
  inLunch: (card) =>
    punches(
      card,
      card.punches.slice(1).map((punch) => punch.in),
    ),
  outDay: (card) => card.punches.at(-1)?.out ?? '—',
  totalHours: (card) => card.hours.toFixed(2),
  condition: (card) => card.status,
};

/** One column per Paycom punch field, for any table whose rows are timecards. */
export const punchColumns = <T extends Timecard>(sortable: boolean): TableColumn<T>[] =>
  paycomColumns.map(([key, label]) => ({
    id: key,
    header: label,
    sortable,
    value: values[key],
    cell: (card) =>
      key === 'condition' ? (
        <Badge value={card.status.toLowerCase() === 'complete' ? 'ready' : 'pending'}>
          {card.status}
        </Badge>
      ) : (
        values[key](card)
      ),
  }));
