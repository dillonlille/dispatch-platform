import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  cortexClock,
  fullName,
  mealPairs,
  type MealEmployee,
} from '../../../../../shared/meal-breaks.js';

import { Clock, GapBadge, LunchCell } from './cells.js';

export function EmployeeRows({
  row,
  summary,
  date,
  name,
  expanded,
  toggle,
}: {
  row: MealEmployee;
  summary: ReturnType<typeof mealPairs>;
  date: string;
  name: string;
  expanded: boolean;
  toggle: () => void;
}) {
  const hiddenGap =
    !expanded &&
    summary.pairs.slice(1).some((p) => p.gaps.before?.overLimit || p.gaps.after?.overLimit);
  return (
    <>
      {(expanded ? summary.pairs : summary.pairs.slice(0, 1)).map((pair, index) => (
        <tr key={index} className={index ? 'meal-extra' : ''}>
          <th scope="row">
            {index === 0 ? (
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
                  {hiddenGap && (
                    <small className="meal-other-gap">Gap over 5m on another meal</small>
                  )}
                </span>
              </div>
            ) : (
              <span className="meal-extra-label">Meal {index + 1}</span>
            )}
          </th>
          <td>
            <Clock value={index === 0 ? summary.paycom.inDay : null} />
          </td>
          <td className={`meal-delivery${pair.gaps.before?.overLimit ? ' has-gap' : ''}`}>
            <Clock
              value={
                pair.cortex
                  ? cortexClock(pair.cortex.lastDelivery, date, pair.cortex.timezone)
                  : null
              }
            />
            {pair.cortex && <GapBadge gap={pair.gaps.before} side="before" />}
          </td>
          <LunchCell paycom={pair.lunch?.out} cortex={pair.out} difference={pair.outDifference} />
          <LunchCell paycom={pair.lunch?.in} cortex={pair.into} difference={pair.inDifference} />
          <td className={`meal-delivery${pair.gaps.after?.overLimit ? ' has-gap' : ''}`}>
            <Clock
              value={
                pair.cortex
                  ? cortexClock(pair.cortex.firstDelivery, date, pair.cortex.timezone)
                  : null
              }
            />
            {pair.cortex && <GapBadge gap={pair.gaps.after} side="after" />}
          </td>
          <td>
            <Clock value={index === 0 ? summary.paycom.outDay : null} />
          </td>
          <td>
            {index === 0 && (
              <span
                className={`meal-status ${summary.missing || summary.different ? 'attention' : ''}`}
              >
                {summary.status}
              </span>
            )}
          </td>
        </tr>
      ))}
      {expanded && (
        <tr className="meal-detail">
          <td colSpan={8}>
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
                      <p className="muted">
                        Labels follow the complete timecard’s punch-pair order.
                      </p>
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
                        Meal {i + 1} · {fullName(meal.driverName)} · {meal.station} ·{' '}
                        {meal.timezone}
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
                    Meals appear in each source’s time order. Differences are shown only when the
                    meal counts agree.
                  </p>
                )}
              </section>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
