import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addDays,
  addMonths,
  clampDay,
  dayLabel,
  displayDay,
  monthLabel,
  monthOf,
  monthWeeks,
  parseDay,
  sameDayOf,
  weekdayOf,
} from '../lib/calendar.js';

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/**
 * A date that can be typed, or chosen from a calendar that opens from anywhere on the field.
 * Days are `YYYY-MM-DD`; `today` is the caller's idea of the current day, not the device's.
 * The field is plain text: a browser's own date field adds icons and selects part of the
 * date on a press, neither of which can be styled away everywhere.
 */
export function DateField({
  label,
  value,
  min,
  max,
  today,
  onChange,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  today: string;
  onChange: (day: string) => void;
}) {
  const field = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // The day the arrow keys are on. Its month is the month in view.
  const [active, setActive] = useState(value);
  const [entered, setEntered] = useState(false);
  // What is being typed, until Enter or leaving the field commits or discards it.
  const [draft, setDraft] = useState<string>();
  const month = monthOf(active);

  const show = (enter: boolean) => {
    setActive(clampDay(value, min, max));
    setEntered(enter);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) input.current?.focus();
  };
  const commit = () => {
    const day = draft === undefined ? undefined : parseDay(draft);
    setDraft(undefined);
    if (day && day >= min && day <= max && day !== value) onChange(day);
  };
  const move = (day: string) => setActive(clampDay(day, min, max));

  // The field sits inside containers that clip, so the calendar is placed against the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = field.current!.getBoundingClientRect();
      const menu = panel.current!;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8));
      const below = anchor.bottom + 6;
      const top =
        below + menu.offsetHeight <= window.innerHeight - 8
          ? below
          : Math.max(8, anchor.top - menu.offsetHeight - 6);
      Object.assign(menu.style, { left: `${left}px`, top: `${top}px`, visibility: 'visible' });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, month]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!field.current!.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  // Once the keyboard is inside the calendar, focus follows the active day across months.
  useEffect(() => {
    if (open && entered)
      panel.current?.querySelector<HTMLElement>(`[data-day="${active}"]`)?.focus();
  }, [open, entered, active]);

  function keys(event: KeyboardEvent) {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(active, -1),
      ArrowRight: () => addDays(active, 1),
      ArrowUp: () => addDays(active, -7),
      ArrowDown: () => addDays(active, 7),
      PageUp: () => sameDayOf(active, addMonths(month, -1)),
      PageDown: () => sameDayOf(active, addMonths(month, 1)),
      Home: () => addDays(active, -weekdayOf(active)),
      End: () => addDays(active, 6 - weekdayOf(active)),
    };
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
    } else if (step[event.key]) {
      event.preventDefault();
      setEntered(true);
      move(step[event.key]!());
    }
  }

  return (
    <div
      className="date-field"
      ref={field}
      onBlur={(event) => {
        // A press elsewhere is handled above; this closes the calendar when Tab leaves it.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          setOpen(false);
      }}
    >
      <input
        ref={input}
        type="text"
        // The calendar is the way to choose on a touch screen, so no keyboard slides up.
        inputMode="none"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-haspopup="dialog"
        // Until someone types, the field only shows the date: no text cursor and no selection.
        data-typing={draft === undefined ? undefined : ''}
        value={draft ?? displayDay(value)}
        onChange={(event) => setDraft(event.target.value)}
        onSelect={({ currentTarget: field }) => {
          if (draft === undefined && field.selectionStart !== field.selectionEnd)
            field.setSelectionRange(field.value.length, field.value.length);
        }}
        onPaste={(event) => {
          if (draft !== undefined) return;
          event.preventDefault();
          setDraft(event.clipboardData.getData('text'));
        }}
        onBlur={commit}
        onClick={() => {
          if (open) setOpen(false);
          else show(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setDraft(undefined);
            if (open) close(false);
          } else if (event.key === 'Enter' && draft !== undefined) {
            commit();
            setOpen(false);
          } else if (event.key === 'Enter' || event.key === 'ArrowDown') {
            event.preventDefault();
            show(true);
          } else if (draft === undefined && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // With no cursor to aim, the first keystroke starts the date over.
            const erase = event.key === 'Backspace' || event.key === 'Delete';
            if (!erase && event.key.length !== 1) return;
            event.preventDefault();
            setDraft(erase ? '' : event.key);
          }
        }}
      />
      {open && (
        <div
          ref={panel}
          className="date-calendar"
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()}`}
          onKeyDown={keys}
        >
          <div className="date-calendar-month">
            <button
              className="icon-button"
              aria-label="Previous month"
              disabled={month <= monthOf(min)}
              onClick={() => move(sameDayOf(active, addMonths(month, -1)))}
            >
              <ChevronLeft size={16} />
            </button>
            <strong aria-live="polite">{monthLabel(month)}</strong>
            <button
              className="icon-button"
              aria-label="Next month"
              disabled={month >= monthOf(max)}
              onClick={() => move(sameDayOf(active, addMonths(month, 1)))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {/* Not a <table>: a page's table styles must not reach into the calendar. */}
          <div className="date-calendar-grid" role="grid" aria-label={monthLabel(month)}>
            <div role="row">
              {weekdays.map((name) => (
                <span key={name} role="columnheader">
                  {name}
                </span>
              ))}
            </div>
            {monthWeeks(month).map((week, index) => (
              <div key={index} role="row">
                {week.map((day, column) => (
                  <span key={column} role="gridcell" aria-selected={day === value}>
                    {day && (
                      <button
                        className="date-calendar-day"
                        data-day={day}
                        tabIndex={day === active ? 0 : -1}
                        aria-label={dayLabel(day)}
                        aria-current={day === today ? 'date' : undefined}
                        aria-pressed={day === value}
                        disabled={day < min || day > max}
                        onClick={() => {
                          setDraft(undefined);
                          onChange(day);
                          close(true);
                        }}
                      >
                        {Number(day.slice(8))}
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
