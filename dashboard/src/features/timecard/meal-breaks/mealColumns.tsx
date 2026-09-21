import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  cortexClock,
  fullName,
  mealPairs,
  type ClockTime,
  type MealEmployee,
} from '../../../../../shared/meal-breaks.js';
import type { TableColumn } from '../../../ui/index.js';
import { Clock, GapBadge, LunchCell, Source } from './cells.js';

type Summary = ReturnType<typeof mealPairs>;
type Pair = Summary['pairs'][number];
/** One meal of one employee. The first meal is the employee's row; the rest sit beneath it. */
export interface MealLine {
  id: string;
  row: MealEmployee;
  summary: Summary;
  name: string;
  date: string;
  pair: Pair;
  index: number;
  more?: MealLine[];
}
export function mealLines(
  row: MealEmployee,
  summary: Summary,
  name: string,
  date: string,
): MealLine {
  const [first, ...rest] = summary.pairs.map(
    (pair, index): MealLine => ({
      id: index ? `${row.id}:${index}` : row.id,
      row,
      summary,
      name,
      date,
      pair,
      index,
    }),
  );
  return { ...first!, more: rest };
}

const delivery = (line: MealLine, side: 'lastDelivery' | 'firstDelivery') =>
  line.pair.cortex
    ? cortexClock(line.pair.cortex[side], line.date, line.pair.cortex.timezone)
    : null;
const text = (clock?: ClockTime | null) =>
  clock ? `${clock.label}${clock.day ? ` (${clock.day > 0 ? '+' : ''}${clock.day}d)` : ''}` : '';
// An export row is an employee, so a column with several meals lists them in order.
const meals = (line: MealLine, value: (meal: MealLine) => string) =>
  [line, ...(line.more ?? [])].map(value).join('; ');

export const mealColumns: TableColumn<MealLine>[] = [
  {
    id: 'employee',
    header: 'Employee ',
    name: 'Employee',
    scope: 'col',
    rowHeader: true,
    sortable: true,
    sticky: true,
    sortHeader: {
      className: 'meal-sort',
      indicator: (direction) => <span aria-hidden="true">{direction === 'desc' ? '↓' : '↑'}</span>,
    },
    value: (line) => line.name,
    cell: ({ name, summary, index }, { expanded, toggle }) =>
      index === 0 ? (
        <div className="meal-employee">
          <button
            className="meal-expand"
            aria-expanded={expanded}
            aria-label={`Details for ${name}`}
            onClick={toggle}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <span>
            {name}
            {summary.pairs.length > 1 && <small>{summary.pairs.length} meals</small>}
            {!expanded &&
              summary.pairs
                .slice(1)
                .some((pair) => pair.gaps.before?.overLimit || pair.gaps.after?.overLimit) && (
                <small className="meal-other-gap">Gap over 5m on another meal</small>
              )}
          </span>
        </div>
      ) : (
        <span className="meal-extra-label">Meal {index + 1}</span>
      ),
  },
  {
    id: 'inDay',
    header: (
      <>
        IN DAY
        <Source name="Paycom" />
      </>
    ),
    name: 'IN DAY',
    scope: 'col',
    value: (line) => text(line.summary.paycom.inDay),
    cell: (line) => <Clock value={line.index === 0 ? line.summary.paycom.inDay : null} />,
  },
  {
    id: 'lastDelivery',
    header: (
      <>
        Last delivery
        <Source name="Flex" />
      </>
    ),
    name: 'Last delivery',
    scope: 'col',
    className: (line) => `meal-delivery${line.pair.gaps.before?.overLimit ? ' has-gap' : ''}`,
    exports: [
      ['Last delivery', (line) => meals(line, (meal) => text(delivery(meal, 'lastDelivery')))],
    ],
    cell: (line) => (
      <>
        <Clock value={delivery(line, 'lastDelivery')} />
        {line.pair.cortex && <GapBadge gap={line.pair.gaps.before} side="before" />}
      </>
    ),
  },
  {
    id: 'outLunch',
    header: 'OUT LUNCH',
    scope: 'col',
    headerClassName: 'meal-lunch',
    className: 'meal-lunch',
    exports: [
      ['OUT LUNCH Paycom', (line) => meals(line, (meal) => text(meal.pair.lunch?.out))],
      ['OUT LUNCH Flex', (line) => meals(line, (meal) => text(meal.pair.out))],
    ],
    cell: ({ pair }) => (
      <LunchCell paycom={pair.lunch?.out} cortex={pair.out} difference={pair.outDifference} />
    ),
  },
  {
    id: 'inLunch',
    header: 'IN LUNCH',
    scope: 'col',
    headerClassName: 'meal-lunch',
    className: 'meal-lunch',
    exports: [
      ['IN LUNCH Paycom', (line) => meals(line, (meal) => text(meal.pair.lunch?.in))],
      ['IN LUNCH Flex', (line) => meals(line, (meal) => text(meal.pair.into))],
    ],
    cell: ({ pair }) => (
      <LunchCell paycom={pair.lunch?.in} cortex={pair.into} difference={pair.inDifference} />
    ),
  },
  {
    id: 'firstDelivery',
    header: (
      <>
        First delivery
        <Source name="Flex" />
      </>
    ),
    name: 'First delivery',
    scope: 'col',
    className: (line) => `meal-delivery${line.pair.gaps.after?.overLimit ? ' has-gap' : ''}`,
    exports: [
      ['First delivery', (line) => meals(line, (meal) => text(delivery(meal, 'firstDelivery')))],
    ],
    cell: (line) => (
      <>
        <Clock value={delivery(line, 'firstDelivery')} />
        {line.pair.cortex && <GapBadge gap={line.pair.gaps.after} side="after" />}
      </>
    ),
  },
  {
    id: 'outDay',
    header: (
      <>
        OUT DAY
        <Source name="Paycom" />
      </>
    ),
    name: 'OUT DAY',
    scope: 'col',
    value: (line) => text(line.summary.paycom.outDay),
    cell: (line) => <Clock value={line.index === 0 ? line.summary.paycom.outDay : null} />,
  },
  {
    id: 'comparison',
    header: 'Comparison',
    scope: 'col',
    value: (line) => line.summary.status,
    cell: ({ index, summary }) =>
      index === 0 && (
        <span className={`meal-status ${summary.missing || summary.different ? 'attention' : ''}`}>
          {summary.status}
        </span>
      ),
  },
];

/** Every collected punch and meal behind an employee's row. */
export function MealDetail({ line: { row, summary } }: { line: MealLine }) {
  return (
    <div className="meal-detail-grid">
      <section>
        <h3>Paycom punches</h3>
        {row.paycom ? (
          <>
            <p>
              {fullName(row.paycom.name)} · {row.paycom.employeeCode}
            </p>
            <ul>
              {summary.paycom.events.map((event, i) => (
                <li key={i}>
                  <span>{event.kind}</span>
                  <Clock value={event.time} />
                  {!event.time && <span>{event.raw}</span>}
                </li>
              ))}
            </ul>
            {summary.paycom.legacy && (
              <p className="muted">Labels follow the complete timecard’s punch-pair order.</p>
            )}
            {summary.paycom.review && (
              <p>Some punch labels are unavailable. Review the collected punches above.</p>
            )}
          </>
        ) : (
          <p>No Paycom punches for this employee on this date.</p>
        )}
      </section>
      <section>
        <h3>Flex meals</h3>
        {row.cortex.length ? (
          row.cortex.map((meal, i) => (
            <div key={`${meal.itineraryId}:${meal.mealId}`}>
              <p>
                Meal {i + 1} · {fullName(meal.driverName)} · {meal.station} · {meal.timezone}
              </p>
              <p className="muted">
                Last delivery:{' '}
                {meal.beforeStatus === 'verified'
                  ? 'available'
                  : meal.beforeStatus === 'absent'
                    ? 'none before this meal'
                    : 'unavailable'}
                . First delivery:{' '}
                {meal.afterStatus === 'verified'
                  ? 'available'
                  : meal.afterStatus === 'absent'
                    ? 'none after this meal'
                    : meal.afterStatus === 'pending'
                      ? 'meal has not ended'
                      : 'unavailable'}
                .
              </p>
            </div>
          ))
        ) : (
          <p>No Flex meal collected for this employee on this date.</p>
        )}
        {summary.pairs.length > 1 && (
          <p className="muted">
            Meals appear in each source’s time order. Differences are shown only when the meal
            counts agree.
          </p>
        )}
      </section>
    </div>
  );
}
